# Alfred

An AI journal and second brain that lives natively in iMessage. Text it notes, voice memos, and files. It remembers everything, surfaces connections, fires reminders, and checks in — like texting a really attentive friend.

---

## What it does

**Capture anything**
- Text notes → stored and remembered
- Voice memos → transcribed via Whisper, then stored
- Images → described via GPT-4o Vision, then stored
- Files (PDF, DOCX, txt) → summarized, then stored

**Memory that compounds**
- Every message is decomposed into atomic facts and embedded
- Facts are organized into three abstraction levels: events/state, patterns, identity/values
- Temporary level-0 facts expire and consolidate into durable patterns when repeated
- Contradictions and refinements preserve history through directed graph edges
- Hybrid retrieval: identity anchors + structural bedrock + semantic/keyword detail + graph expansion

**Proactive (not just reactive)**
- 9am morning brief: what's on your plate today
- 1pm: surfaces a connection from your past
- 7pm: wraps up the day, checks in if you've gone quiet
- Fires reminders inline when they come due

**Todoist integration**
- Alfred sees your open tasks and references them naturally
- Detects actionable intent in messages and auto-creates tasks ("i gotta email Jake back" → creates task)

**Tone**
Casual, lowercase, Gen Z. Feels like texting a friend, not querying a database.

---

## Architecture

```
User texts madsoccerfeet@gmail.com (Alfred's Apple ID)
        ↓
imessage-kit WAL watcher (onDirectMessage)
        ↓
Message router — text / audio / image / file
  audio → ffmpeg → Whisper API → transcript
  image → GPT-4o Vision → description
  file  → pdf-parse / mammoth → summary
        ↓
LLM call (context window assembled from 3 memory tiers)
        ↓
Response → split on [SPLIT] → send each bubble with 800ms pacing
        ↓
Background: extract facts + reminders + Todoist tasks from message
```

### Memory tiers

| Tier | What | Where |
|---|---|---|
| Short-term | Last 20 messages | In-process `ConversationBuffer` |
| Working | Active reminders + user profile | SQLite |
| Long-term | Every extracted fact, embedded | ChromaDB (local) |

### Retrieval layers

1. Core identity: latest level-2 facts, always injected once
2. Foundational patterns: level-1 facts ranked by descendant count
3. Relevant detail: ChromaDB semantic search + SQLite FTS5 merged with RRF
4. Upward graph expansion: retrieved details pull in `instance_of` parents
5. Lateral graph expansion: small same-level `relates_to` budget

### Folder structure

```
src/
  index.ts                    ← entry point
  config.ts                   ← zod-validated env vars
  db/schema.ts                ← SQLite schema (7 tables)
  ingestion/
    router.ts                 ← classifies message type
    transcription.ts          ← ffmpeg + Whisper
    fileParser.ts             ← PDF/DOCX/image → summary
  memory/
    shortTerm.ts              ← ConversationBuffer
    facts.ts                  ← SQLite CRUD
    vectors.ts                ← ChromaDB client (OpenAI embeddings)
    extractor.ts              ← background LLM extraction
    consolidation.ts          ← expiry + pattern/identity promotion
    resolver.ts               ← contradiction detection
    retrieval.ts              ← hybrid retrieval + re-ranking
  orchestrator/
    context.ts                ← assembles context window
    llm.ts                    ← OpenAI-compatible chat calls
    response.ts               ← multi-bubble send
  proactive/
    engine.ts                 ← 3 daily cron jobs
    gate.ts                   ← quiet hours + spam prevention
  tone/
    systemPrompt.ts           ← Alfred's personality + context injection
  integrations/
    todoist.ts                ← read tasks, create tasks
```

---

## Setup

### Prerequisites

- macOS (required — iMessage is Mac-only)
- Node.js 20+
- pnpm (`npm install -g pnpm`)
- Python 3 + pipx (`brew install pipx`)
- ffmpeg (`brew install ffmpeg`) — for audio transcription
- ChromaDB (`pipx install chromadb`)
- An OpenAI API key (or compatible provider)

### iMessage account setup

Alfred needs its own Apple ID so it has a distinct iMessage address to receive messages.

1. Create a new Apple ID at [appleid.apple.com](https://appleid.apple.com) using a spare Gmail address (not an `@icloud.com` address — Apple won't let you create those directly)
2. On your Mac, create a **separate macOS user account** (System Settings → Users & Groups → Add Account) — call it "alfred"
3. Log into the alfred macOS user, open Messages, and sign in with the new Apple ID
4. Send a test iMessage from your iPhone to that Gmail address — it should appear in Alfred's Messages on Mac
5. Switch back to your main user account — Alfred's Messages session stays active in the background

> **Why a separate macOS user?** macOS Messages only supports one Apple ID at a time. A second user account gives Alfred its own isolated Messages session without affecting yours.

### Installation

```bash
# Clone
git clone https://github.com/shivamg05/alfred.git
cd alfred

# Install dependencies
pnpm install

# Build better-sqlite3 native module (required once)
cd node_modules/better-sqlite3 && node-gyp configure build && cd ../..

# Copy and fill in env
cp .env.example .env
```

Edit `.env`:
```
ALFRED_PHONE=yourbot@gmail.com        # the Apple ID Alfred listens on
USER_PHONE=+1xxxxxxxxxx               # your phone number
OPENAI_API_KEY=sk-...
DB_PATH=/Users/alfred/alfred.db       # writable by the alfred macOS user
IMESSAGE_DB_PATH=/Users/alfred/Library/Messages/chat.db
TODOIST_API_TOKEN=...                 # optional
```

### Grant permissions

In System Settings → Privacy & Security → Full Disk Access → enable **Terminal** (or whatever terminal app you use).

### Run

In one terminal tab, start ChromaDB:
```bash
chroma run --path ./chroma_data
```

In another tab, **switch to the alfred macOS user** (fast user switching or open a terminal session as alfred), then:
```bash
/opt/homebrew/bin/node --import /path/to/alfred/node_modules/tsx/dist/esm/index.cjs /path/to/alfred/src/index.ts
```

Alfred starts watching. Text its Apple ID from your iPhone.

### Using a cheaper LLM provider

Alfred uses an OpenAI-compatible interface. To use Gemini Flash (~10x cheaper):

```env
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
OPENAI_API_KEY=<your Gemini API key>
LLM_MODEL=gemini-2.0-flash
EXTRACTION_MODEL=gemini-2.0-flash
```

---

## Database schema

```sql
messages          -- raw messages + transcripts/summaries
memory_facts      -- atomic facts extracted from messages
                  -- abstraction_level, descendant_count, is_latest, is_forgotten
fact_relations    -- typed relations: instance_of | relates_to | updates | extends | derives | consolidated_from
reminders         -- due_at reminders, fired_at tracking
user_profile      -- materialized static + dynamic facts about the user
proactive_log     -- log of every proactive message sent
```

---

## Scaling (Phase 2 notes)

Phase 1 runs entirely on your Mac. When ready to scale:

| Component | Phase 1 | Phase 2 |
|---|---|---|
| iMessage | Local Mac user | MacStadium / AWS EC2 Mac fleet |
| Database | SQLite + ChromaDB | PostgreSQL + pgvector |
| App server | Local process | Fly.io / Railway |
| Secrets | `.env` | Doppler / AWS Secrets Manager |
| Multi-user | `user_id = 'local'` hardcoded | `user_id` column already in every table |

The SQLite schema includes `user_id` on every table so multi-tenancy is an `ALTER TABLE` away, not a redesign.
