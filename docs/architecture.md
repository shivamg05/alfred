# Alfred: Architecture

## Overview

Alfred is a local-first, single-user AI journal that runs on macOS. The core loop:

1. User texts Alfred's Apple ID from iPhone
2. imessage-kit detects the message via SQLite WAL events
3. Alfred classifies, processes, and responds
4. Background job extracts structured memory from the message

Everything runs on one Mac. No cloud infra required for Phase 1.

---

## Data flow

```
User's iPhone
    │ iMessage
    ▼
Alfred's Apple ID (madsoccerfeet@gmail.com)
    │ signed into Messages on "alfred" macOS user
    ▼
~/Library/Messages/chat.db  ←── WAL watcher (imessage-kit)
    │
    ▼
Message handler (src/index.ts onDirectMessage)
    │
    ├─ audio? → ffmpeg → Whisper API → transcript
    ├─ image? → GPT-4o Vision → description
    ├─ file?  → pdf-parse/mammoth → Claude summary
    └─ text?  → passthrough
    │
    ▼
insertMessage() → SQLite messages table
    │
    ▼ (parallel)
    ├─ Build context window ──────────────────────────────┐
    │    ├─ ConversationBuffer (last 20 msgs, in-memory)  │
    │    ├─ SQLite: reminders + user_profile              │
    │    ├─ ChromaDB: top 5 semantically similar facts    │
    │    └─ Todoist API: open tasks (cached 30min)        │
    │                                                     │
    │  System prompt assembled ◄──────────────────────────┘
    │         │
    │         ▼
    │    LLM call (gpt-4o-mini / gemini-flash / etc.)
    │         │
    │         ▼
    │    Response split on [SPLIT]
    │         │
    │         ▼
    │    sdk.send() bubbles with 800ms pacing
    │
    └─ Background: extractFromMessage()
           │
           ▼
       LLM extracts: facts / reminders / todoist_tasks
           │
           ├─ facts → insertFact() → SQLite
           │       → ChromaDB upsert (OpenAI embedding)
           │       → graph wiring: updates/extends/instance_of/relates_to
           │       → upsertProfileFact() → user_profile
           ├─ reminders → insertReminder() → SQLite
           └─ todoist_tasks → Todoist REST API
```

---

## Memory layer

### Why not just use embeddings?

Naive embedding similarity ("find the 5 most similar past messages") fails for a journal because:
- Short casual messages embed similarly even when unrelated
- You lose structured information (is this a fact, a reminder, a mood?)
- No version tracking — if you say "stopped going to the gym" you still retrieve "goes to the gym"

Alfred uses **atomic fact extraction** inspired by [supermemory.ai](https://supermemory.ai/research/):
- Each message is decomposed into discrete, self-contained facts
- Facts are embedded individually (not the raw message)
- Facts can be versioned and superseded via `fact_relations`
- Facts are organized into levels: specific event/state (`0`), pattern (`1`), identity/value (`2`)
- Expired level-0 facts can consolidate into higher-level patterns rather than simply disappear

### Three tiers

**Tier 1: ConversationBuffer**
- In-process JavaScript array, last 20 messages
- Zero latency — no DB round trip
- Resets after 4 hours of silence (new session)

**Tier 2: Working memory (SQLite)**
- `user_profile` — static facts (always injected) + dynamic facts (injected when relevant)
- `reminders` — unfired reminders due within the next hour
- Queried synchronously via `better-sqlite3`

**Tier 3: Long-term semantic memory (SQLite graph + ChromaDB)**
- Every extracted fact, embedded with `text-embedding-3-small`
- Query-specific retrieval uses ChromaDB semantic search + SQLite FTS5 merged with RRF
- Always-on context includes level-2 identity anchors and level-1 bedrock patterns
- Retrieved details expand upward through `instance_of` parents, then laterally via `relates_to`

See [memory.md](./memory.md) for the detailed memory graph architecture.

### Fact schema

```
memory_facts
  id                   INTEGER PK
  text                 TEXT     — self-contained, third-person ("User is building...")
  abstraction_level    INTEGER  — 0=event/state, 1=pattern, 2=identity/value
  descendant_count     INTEGER  — cached subtree support count
  root_fact_id         INTEGER  — original fact in a contradiction chain
  parent_fact_id       INTEGER  — the fact this one supersedes
  is_latest            BOOL     — false when a newer fact supersedes this
  is_static            BOOL     — true for stable long-term facts
  document_date        TEXT     — when the message was sent
  event_date           TEXT     — when the described event occurs (nullable)
  forget_after         TEXT     — auto-expire date for temporary facts
  source_message_id    INTEGER  — FK to messages
  chroma_id            TEXT     — corresponding ChromaDB document ID
```

### Contradiction detection

When the extractor LLM detects that a new fact supersedes or refines an old one, it includes a `contradicts_hint` or `extends_hint` in its output. The resolver:

1. Searches existing facts for the hinted old fact
2. Writes an `updates` or `extends` relation from the new fact to the old fact
3. Marks the old fact `is_latest = false`
4. Rewires children only for `extends`; `updates` keeps old children attached as historical evidence

Result: "User moved to Austin" supersedes "User lives in NYC" rather than coexisting.

---

## Proactive engine

Three scheduled jobs + one reactive trigger:

| Trigger | Schedule | What |
|---|---|---|
| Morning brief | 9:00am | Open reminders + dynamic profile + today's Todoist tasks |
| Midday pulse | 1:00pm | Surface one connection from long-term memory |
| Evening wrap | 7:00pm | Check overdue items + inactivity check |
| On-message hook | After every message | Fire any reminder due within 60 minutes |

**Gate checks before every proactive send:**
1. Is it within quiet hours? (`QUIET_HOURS_END` to `QUIET_HOURS_START`) → skip
2. Was a proactive message sent in the last 3 hours? → skip
3. Is the generated message non-empty? → skip if not

---

## iMessage account setup

Apple does not provide a public iMessage API. Alfred uses [imessage-kit](https://github.com/photon-hq/imessage-kit) which:
- Watches `~/Library/Messages/chat.db` via SQLite WAL events
- Sends messages via AppleScript (`osascript`)

**Why a separate macOS user:**
macOS Messages supports only one Apple ID at a time. Alfred needs its own Apple ID to have a distinct iMessage address. A second macOS user account gives Alfred an isolated Messages session without interfering with the main user's iMessages.

**Why not text yourself:**
Messages sent from your own Apple ID are marked `isFromMe = true` in the database — the watcher's `onDirectMessage` callback would never fire.

---

## LLM provider

Alfred uses the OpenAI SDK but supports any OpenAI-compatible endpoint via `LLM_BASE_URL`:

| Provider | Config |
|---|---|
| OpenAI (default) | No `LLM_BASE_URL` needed |
| Gemini Flash | `LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai` |
| Groq | `LLM_BASE_URL=https://api.groq.com/openai/v1` |

**Which calls use which model:**
- `LLM_MODEL` → Alfred's responses, proactive messages
- `EXTRACTION_MODEL` → background fact/reminder extraction (can be cheaper)
- `whisper-1` → audio transcription (hardcoded OpenAI, no compat layer)
- `gpt-4o` → image vision (hardcoded OpenAI)
- `text-embedding-3-small` → fact embeddings (hardcoded OpenAI)

---

## Phase 2: Scaling

The main constraint for scaling is **iMessage requires a Mac**. Apple has no cloud API.

**Options:**
1. **MacStadium / AWS EC2 Mac** — cloud Mac, Alfred runs there, iMessage signed in. ~$99/month per Mac.
2. **Phone number relay** — each user gets a Twilio number registered to a Mac Apple ID. Relay server routes messages to the right Alfred instance. This is how Beeper/Texts.app work.
3. **Drop iMessage** — Phase 2 uses WhatsApp Business API or Telegram Bot API (real cloud APIs). iMessage stays as a power-user option.

**Database migration path:**
- SQLite → PostgreSQL + pgvector (replaces ChromaDB entirely)
- Every table already has `user_id TEXT DEFAULT 'local'` — multi-tenancy is `ALTER TABLE`, not a redesign
- Node process → Fly.io / Railway
