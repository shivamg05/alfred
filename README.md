# Alfred

An AI journal and second brain that lives natively in iMessage. Text it notes, voice memos, and files. It remembers everything, surfaces connections, fires reminders, and checks in — like texting a really attentive friend.

---

## What it does

**Capture anything**
- Text notes → stored and remembered
- Voice memos → transcribed via Gemini Flash, then stored
- Images → described via Claude vision, then stored
- Files (PDF, DOCX, txt) → summarized, then stored

**Memory that compounds**
- Every message is decomposed into atomic facts and embedded
- Facts are organized into three abstraction levels: events/state (`0`), patterns (`1`), identity/values (`2`)
- Level-0 facts expire and consolidate into durable patterns when repeated
- Contradictions and refinements preserve history through a directed knowledge graph
- Hybrid retrieval: identity anchors + structural bedrock + semantic/keyword detail + graph expansion

**Proactive (not just reactive)**
- 9am morning brief: today's tasks + upcoming events
- 1pm: surfaces a heads up if something is happening in the next 48h
- 7pm: checks what's still open on Todoist
- Per-minute cron fires reminders exactly when they come due

**Todoist integration**
- Alfred sees your open tasks and references them naturally in conversation
- Creates tasks only when you explicitly ask ("add X to my todoist")

**Tone**
Casual, lowercase, Gen Z. Feels like texting a friend, not querying a database.

---

## Architecture

```
User texts Alfred's Apple ID
        ↓
imessage-kit WAL watcher (onDirectMessage)
        ↓
Attachment handler — audio / image / file / text
  audio → afconvert (CAF→WAV) → Gemini Flash → transcript
  image → heic-convert → Claude vision → description
  file  → pdf-parse / mammoth → summary
        ↓
insertMessage() → SQLite
        ↓ (parallel)
  ├─ Classifier (Gemini flash-lite) → silent | acknowledge | brief | full
  └─ 1-2s debounce window (batches rapid-fire messages)
        ↓
  ├─ silent    → no response
  ├─ acknowledge → Gemini generates contextual 1-4 word ack
  └─ brief/full → context assembled from 3 memory tiers
                      ↓
                 LLM response loop (Claude haiku-4.5 via OpenRouter)
                 max 8 tool-call iterations
                 tools: search_web, scrape_url, todoist_*
                      ↓
                 Response → split on [SPLIT] → send bubbles (1500ms pacing)
        ↓
Background: session buffer (5 msgs or 2min idle) → extractFromMessage()
  → facts → SQLite + ChromaDB + graph wiring
  → reminders → SQLite (fires via per-minute cron)
```

### Memory tiers

| Tier | What | Where |
|---|---|---|
| Short-term | Last 20 messages, resets after 4h silence | In-process `ConversationBuffer` |
| Working | Level-2 identity + Level-1 bedrock patterns (always-on) | SQLite |
| Long-term | All extracted facts, query-specific retrieval | ChromaDB + SQLite FTS5 |

### Retrieval layers

1. **Core identity**: latest level-2 facts, always injected
2. **Foundational patterns**: level-1 facts ranked by `descendant_count` (subtree support), always injected
3. **Relevant detail**: ChromaDB semantic + SQLite FTS5 merged via RRF, with recency and upcoming-event boosts
4. **Upward graph expansion**: retrieved facts pull in `instance_of` ancestors up to 2 hops
5. **Lateral graph expansion**: small `relates_to` budget for same-level associations

### Folder structure

```
src/
  index.ts                    ← entry point, message handler, debounce
  config.ts                   ← zod-validated env vars
  db/schema.ts                ← SQLite schema + FTS5 virtual table
  ingestion/
    router.ts                 ← message type classification
    transcription.ts          ← CAF→WAV + Gemini Flash transcription
    fileParser.ts             ← PDF/DOCX/image → summary
    attachments.ts            ← WAL-race fallback for attachment lookup
  memory/
    shortTerm.ts              ← ConversationBuffer
    facts.ts                  ← all SQLite reads/writes
    vectors.ts                ← ChromaDB client (OpenAI embeddings)
    extractor.ts              ← session-based LLM fact extraction
    consolidation.ts          ← expiry + L0→L1 and L1→L2 promotion
    retrieval.ts              ← hybrid retrieval + RRF + graph expansion
  orchestrator/
    classifier.ts             ← intent classifier + contextual ack generator
    context.ts                ← context window assembly
    llm.ts                    ← multi-turn tool loop, XML tool-call fallback
    response.ts               ← multi-bubble send with pacing
  proactive/
    engine.ts                 ← cron jobs (reminders, briefs, consolidation)
    gate.ts                   ← quiet hours + spam prevention
  tone/
    systemPrompt.ts           ← Alfred's personality + context injection
  integrations/
    todoist.ts                ← list/create/close/update tasks
  tools/
    registry.ts               ← tool definitions + dispatcher
    web.ts                    ← Firecrawl search + scrape
    todoist.ts                ← tool dispatch layer
```

---

## Setup

See [docs/setup.md](docs/setup.md) for the full setup guide.

### Quick start

```bash
git clone https://github.com/shivamg05/alfred.git
cd alfred
pnpm install
cp .env.example .env
# edit .env — see docs/setup.md
```

Start ChromaDB:
```bash
chroma run --path ./chroma_data
```

Start Alfred (as the `alfred` macOS user):
```bash
/opt/homebrew/bin/node --import ./node_modules/tsx/dist/esm/index.cjs src/index.ts
```

---

## Database schema

```sql
messages            -- raw messages + transcripts/summaries
memory_facts        -- atomic facts; abstraction_level, descendant_count, is_latest, forget_after
memory_facts_fts    -- FTS5 virtual table (auto-synced via triggers)
fact_relations      -- instance_of | relates_to | updates | extends | derives | consolidated_from
reminders           -- due_at reminders, fired_at tracking
user_profile        -- materialized level-1/2 facts for fast profile reads
proactive_log       -- every proactive message sent and when
```

---

## Scaling (Phase 2 notes)

Phase 1 runs entirely on your Mac. The main constraint for scaling is **iMessage requires a Mac** — Apple has no cloud API.

| Component | Phase 1 | Phase 2 |
|---|---|---|
| iMessage | Local Mac user | MacStadium / AWS EC2 Mac fleet |
| Database | SQLite + ChromaDB | PostgreSQL + pgvector |
| App server | Local process | Fly.io / Railway |
| Secrets | `.env` | Doppler / AWS Secrets Manager |
| Multi-user | `user_id = 'local'` hardcoded | `user_id` column already in every table |

The SQLite schema includes `user_id` on every table so multi-tenancy is an `ALTER TABLE` away, not a redesign.
