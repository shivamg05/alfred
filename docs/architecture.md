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
    ├─ audio? → afconvert (CAF→WAV) → Gemini Flash (base64 chat) → transcript
    ├─ image? → heic-convert (HEIC→JPEG) → Claude haiku vision → description
    ├─ file?  → pdf-parse / mammoth → summary
    └─ text?  → passthrough
    │
    ▼
insertMessage() → SQLite messages table
    │
    ▼ (fire-and-forget parallel)
    ├─ Classifier (Gemini flash-lite, ~500ms) ──────────────────────────────┐
    │                                                                        │
    └─ 1-2s debounce (batches rapid-fire messages)                          │
         │                                                                   │
         ▼                                                                   │
    Resolved mode ◄─────────────────────────────────────────────────────────┘
         │
         ├─ silent     → no response
         ├─ acknowledge → Gemini generates contextual 1-4 word ack, send
         └─ brief/full
               │
               ▼
          fetchContext() — 3-tier memory assembly
            ├─ ConversationBuffer (last 20 msgs, in-process)
            ├─ Level-2 identity facts (SQLite, always-on)
            ├─ Level-1 bedrock patterns (SQLite, ranked by descendant_count)
            ├─ Hybrid retrieval: ChromaDB semantic + FTS5 BM25 → RRF merge
            │    + graph expansion: instance_of parents + relates_to neighbors
            └─ Todoist API (only for full mode + task-related queries)
               │
               ▼
          buildPrompt() → system prompt with memory sections
               │
               ▼
          chat() — multi-turn tool loop (max 8 iters)
            model: Claude haiku-4.5 via OpenRouter
            tools: search_web, scrape_url, todoist_list_tasks,
                   todoist_create_task, todoist_close_task, todoist_update_task
            XML tool-call fallback: detects <function_calls>/<tool_use> in
            content text and executes them when structured tool_calls is empty
               │
               ▼
          sendBubbles() — split on [SPLIT], 1500ms between bubbles
    │
    └─ Background: session buffer (batches 5 msgs or 2min idle)
           │
           ▼
       extractFromMessage() — LLM extracts atomic facts + reminders
           ├─ facts → insertFact() → SQLite
           │       → ChromaDB upsert (text-embedding-3-small)
           │       → graph wiring: instance_of / relates_to / updates / extends
           │       → upsertProfileFact() → user_profile (level 1+2 only)
           └─ reminders → insertReminder() → SQLite
                         (fires via per-minute cron, independent of messages)
```

---

## Response modes

| Mode | Trigger | Behavior |
|---|---|---|
| `silent` | Pure reaction ("lol", "fr", "💀") | No response sent |
| `acknowledge` | Explicit command or receipt-only ("noted", "just fyi") | Gemini generates contextual 1-4 word ack |
| `brief` | Sharing, venting, life update, emotional message | 1 sentence ≤15 words, no tools |
| `full` | Explicit question, request, or task | Up to 2 bubbles, tools enabled |

The classifier (Gemini flash-lite) fires immediately when a message arrives, in parallel with retrieval. 5s timeout — defaults to `brief` on failure.

---

## Memory layer

### Why not just use embeddings?

Naive embedding similarity fails for a journal because:
- Short casual messages embed similarly even when unrelated
- You lose structured information (fact vs. mood vs. plan)
- No version tracking — "stopped going to the gym" still retrieves "goes to the gym"

Alfred uses **atomic fact extraction** into a knowledge graph:
- Each message is decomposed into discrete, self-contained facts
- Facts are embedded individually (not the raw message)
- Facts are versioned via directed graph edges (`updates`, `extends`)
- Facts are organized into abstraction levels and linked via `instance_of` hierarchy
- `descendant_count` tracks subtree size for importance ranking

### Three tiers

**Tier 1: ConversationBuffer**
- In-process array, last 20 messages, zero latency
- Resets after 4 hours of silence (new session)
- Seeded from DB on startup

**Tier 2: Working memory (SQLite, always-on)**
- Level-2 identity facts — always injected as `CORE IDENTITY`
- Level-1 bedrock patterns — always injected as `FOUNDATIONAL PATTERNS`, ranked by `descendant_count / (1 + age_days × 0.05)`

**Tier 3: Long-term semantic memory (ChromaDB + FTS5)**
- Every extracted fact, embedded with `text-embedding-3-small`
- Query-specific retrieval via `RELEVANT MEMORY` section
- ChromaDB semantic search + SQLite FTS5 BM25 merged via RRF
- Recency half-life: 30 days. Upcoming events get a boost.
- Graph expansion: upward via `instance_of` (2 hops), then lateral via `relates_to`

See [memory.md](./memory.md) for the full knowledge graph architecture.

---

## Proactive engine

| Trigger | Schedule | What |
|---|---|---|
| Reminder cron | Every minute | Fires any reminders past their `due_at` |
| Morning brief | 9:00am | Today's Todoist tasks + upcoming events from memory |
| Midday pulse | 1:00pm | Heads up if something happening in next 48h |
| Evening wrap | 7:00pm | Check open/overdue Todoist tasks |
| L0 consolidation | Every 6h | Expire L0 facts, cluster into L1 patterns |
| L1→L2 promotion | Weekly (Sunday 3:30am) | Promote supported patterns to identity/values |

**Gate checks before every proactive send:**
1. Within quiet hours? → skip
2. Proactive message sent in last 3 hours? → skip (spam prevention)
3. LLM returns `SKIP`? → skip

Proactive messages have tools enabled — the morning brief and evening wrap use `todoist_list_tasks` to get real data, not cached context.

---

## Extraction

Messages are buffered (up to 5, or 2 min idle) then sent to an LLM extraction call. The extractor:

- Injects existing profile + FTS-matched topical facts so the model skips near-duplicates
- Pre-insertion guard: skips facts with ChromaDB distance < 0.18 to an existing fact
- Assigns `abstraction_level` (0/1/2) and computes `forget_after` for L0 only
- Auto-wires `instance_of` parent edges (via hints + semantic parent search)
- Auto-wires same-level `relates_to` edges for new facts with distance 0.12–0.55
- Handles `contradicts_hint` → `updates` edge + mark old `is_latest=0`
- Handles `extends_hint` → `extends` edge + rewire children to new fact

**Reminders** — created only on explicit user requests ("remind me to...", "don't let me forget"). Time-bound statements of intent ("I need to X in 2 hours") also qualify. Vague intent without a timeframe does not.

**Todoist tasks** — never created by the extractor. Only created when the user explicitly asks Alfred during a conversation via the `todoist_create_task` tool.

---

## Tool calls

Alfred uses structured API `tool_calls` when the model supports them. Claude models via OpenRouter sometimes output tool calls as embedded XML text (`<function_calls>` or `<tool_use>` format) instead. The `chat()` loop in `orchestrator/llm.ts` detects both formats, executes them, and continues the loop — the user never sees raw XML.

---

## iMessage account setup

Apple provides no public iMessage API. Alfred uses [imessage-kit](https://github.com/photon-hq/imessage-kit) which:
- Watches `~/Library/Messages/chat.db` via SQLite WAL events
- Sends messages via AppleScript (`osascript`)

**Why a separate macOS user:** macOS Messages supports only one Apple ID at a time. Alfred needs its own Apple ID to have a distinct iMessage address. A second macOS user account gives Alfred an isolated Messages session.

**Why not text yourself:** Messages sent from your own Apple ID are marked `isFromMe = true` — the watcher's `onDirectMessage` callback would never fire.

---

## LLM calls

All LLM calls go through the OpenAI SDK pointed at `LLM_BASE_URL` (currently OpenRouter).

| Call | Model | Notes |
|---|---|---|
| Alfred's responses | `LLM_MODEL` (claude haiku-4.5) | Multi-turn tool loop, max 200 tokens |
| Classifier | `google/gemini-2.5-flash-lite` | 5s timeout, hardcoded |
| Contextual acks | `google/gemini-2.5-flash-lite` | 1-4 words, max 20 tokens |
| Extraction | `EXTRACTION_MODEL` | Max 1500 tokens, JSON mode |
| Proactive | `LLM_MODEL` | Max 150 tokens, tools enabled |
| Transcription | `google/gemini-2.5-flash-lite` | Base64 WAV via `input_audio` |
| Image vision | `anthropic/claude-haiku-4-5` | Via OpenRouter |
| Embeddings | `openai/text-embedding-3-small` | Via LLM_BASE_URL |

---

## Phase 2: Scaling

The main constraint for scaling is **iMessage requires a Mac**. Apple has no cloud API.

**Options:**
1. **MacStadium / AWS EC2 Mac** — cloud Mac, Alfred runs there, iMessage signed in. ~$99/month per Mac.
2. **Phone number relay** — each user gets a Twilio number registered to a Mac Apple ID. Relay server routes messages to the right Alfred instance.
3. **Drop iMessage** — Phase 2 uses WhatsApp Business API or Telegram Bot API. iMessage stays as a power-user option.

**Database migration path:**
- SQLite → PostgreSQL + pgvector (replaces ChromaDB entirely)
- Every table already has `user_id TEXT DEFAULT 'local'` — multi-tenancy is `ALTER TABLE`, not a redesign
- Node process → Fly.io / Railway
