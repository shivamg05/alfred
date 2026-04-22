# Alfred — Codebase Guide for Claude

## What this is

Alfred is a personal AI journal and second brain that lives natively in iMessage. It's a TypeScript/Node.js app that runs locally on macOS, watches the Messages database via imessage-kit, processes incoming messages, maintains a memory layer, and replies with a casual Gen Z tone.

## Running it

Alfred must run as the `alfred` macOS user (who owns the Messages database):

```bash
/opt/homebrew/bin/node --import /Users/shivamgarg/dev/alfred/node_modules/tsx/dist/esm/index.cjs /Users/shivamgarg/dev/alfred/src/index.ts
```

ChromaDB must be running separately:
```bash
chroma run --path ./chroma_data
```

Type-check only (no run):
```bash
pnpm typecheck
```

## Architecture in one paragraph

iMessage messages arrive via the imessage-kit WAL watcher → routed by type (text/audio/image/file) → transcribed or summarized if needed → stored in SQLite → LLM response generated with a 3-tier context window (in-memory buffer + SQLite working memory + ChromaDB semantic search) → sent back as multiple iMessage bubbles → background job extracts atomic facts, reminders, and Todoist tasks from the message.

## Key files

| File | Role |
|---|---|
| `src/index.ts` | Entry point. Wires everything: DB init, watcher, cron jobs, session buffer, message handler |
| `src/config.ts` | All env vars parsed and validated with Zod. Always use `config()` not `process.env` directly |
| `src/db/schema.ts` | SQLite schema + FTS5 virtual table on `memory_facts`. Call `db()` to get the singleton |
| `src/memory/facts.ts` | All SQLite reads/writes for facts, reminders, profile, proactive log. Includes `searchFactsFTS()` |
| `src/memory/vectors.ts` | ChromaDB client. Uses `text-embedding-3-small` via OpenRouter (or direct OpenAI if key is native) |
| `src/memory/extractor.ts` | Session-based extraction: 5-category prompt, dedup via existing profile injection, contradiction resolver |
| `src/memory/retrieval.ts` | Hybrid retrieval: ChromaDB semantic + FTS5 BM25 merged via RRF, with source chunk injection |
| `src/orchestrator/context.ts` | Assembles the context window from all 3 memory tiers + Todoist task cache |
| `src/orchestrator/classifier.ts` | Intent classifier: `silent \| brief \| full` — determines response mode before LLM call |
| `src/orchestrator/llm.ts` | Multi-iteration tool-calling loop (max 8 turns). Tools run in parallel via Promise.all |
| `src/tone/systemPrompt.ts` | Alfred's personality + mode-aware length rules + NOW timestamp injection |
| `src/proactive/engine.ts` | Three cron jobs: 9am brief, 1pm connection, 7pm wrap |
| `src/integrations/todoist.ts` | Todoist API v1: list (with filters), create, close, update tasks |
| `src/tools/registry.ts` | Tool definitions (OpenAI schema) + dispatcher. Logs both call and result |
| `src/tools/web.ts` | Firecrawl v2 search + scrape. Rewrites Twitter/X URLs to fxtwitter.com |
| `src/tools/todoist.ts` | Tool dispatch layer over `integrations/todoist.ts` |

## Memory layer

Three tiers assembled into every context window:

1. **Short-term** — `ConversationBuffer` in process memory. Last 20 messages, resets after 4h silence
2. **Working memory** — SQLite. Active reminders + user profile (static and dynamic facts)
3. **Long-term** — ChromaDB + FTS5. Every extracted fact, searchable semantically and by keyword

### Extraction (session-based)

Messages are buffered (up to 5, or 2 min idle) then extracted as a batch. This gives the LLM full conversation context for better coreference resolution. The extractor:
- Injects existing profile facts into the prompt so the model skips duplicates
- Extracts across 5 categories: Profile, Current Context, Preferences, Events, Updates
- Runs a contradiction resolver: facts with `contradicts_hint` trigger an FTS5 search for the old fact → writes `fact_relations` row, marks old as `is_latest = 0`
- Mirrors every created Todoist task as a local reminder (fires at 9am on due date, or now+30min)

### Retrieval (hybrid RRF)

At response time, both ChromaDB (semantic) and FTS5 (BM25 keyword) are queried. Results are merged via Reciprocal Rank Fusion, then each retrieved fact is annotated with its source message snippet for richer LLM context.

## LLM calls

All LLM calls go through the OpenAI SDK pointed at `LLM_BASE_URL`. Currently: OpenRouter (`https://openrouter.ai/api/v1`). Model IDs use OpenRouter's namespaced format (`openai/gpt-4o-mini`).

- **Responses**: `chat()` in `orchestrator/llm.ts` — multi-turn tool loop, `LLM_MODEL`, max 200 tokens
- **Classifier**: `classifyIntent()` in `orchestrator/classifier.ts` — `EXTRACTION_MODEL`, max 20 tokens, temp 0
- **Extraction**: `extractFromMessage()` in `memory/extractor.ts` — `EXTRACTION_MODEL`, max 1500 tokens
- **Proactive**: `generateProactive()` in `orchestrator/llm.ts` — `LLM_MODEL`, max 150 tokens
- **Embeddings**: `vectors.ts` — routes through `LLM_BASE_URL` when set, model `openai/text-embedding-3-small`
- **Transcription**: `transcribeAudio()` — hardcoded to OpenAI `whisper-1` (needs real OpenAI key)
- **Image**: `summarizeImage()` — hardcoded to OpenAI `gpt-4o` (needs real OpenAI key)

## Response flow

```
message → classifyIntent() → silent | brief | full
  silent (40% chance) → send random ack (👍 👀 noted gotcha)
  brief/full → buildContext() → chat() tool loop → sendBubbles()
  always → queueForExtraction() → session buffer → extractFromMessage()
```

## Tone / personality

`src/tone/systemPrompt.ts` is the only place Alfred's personality is defined. Key rules:
- Lowercase, no em dashes, minimal punctuation
- Direct and opinionated — commits to takes, doesn't hedge
- Swears when it fits naturally, not constantly
- `brief` mode: 1 sentence, ≤20 words. `full` mode: max 2 bubbles, ≤25 words each
- `[SPLIT]` between bubbles, 800ms delay in `orchestrator/response.ts`
- Current datetime injected at top of every prompt (user's timezone from `USER_TIMEZONE`)

## SQLite schema summary

```
messages            — raw + transcript/summary, imessage_row_id
memory_facts        — atomic facts, versioned (root/parent FK), is_latest, is_static, forget_after
memory_facts_fts    — FTS5 virtual table (auto-synced via triggers)
fact_relations      — updates | extends | derives
reminders           — due_at, fired_at (includes mirrored Todoist tasks)
user_profile        — materialized static + dynamic facts (key/value)
proactive_log       — what Alfred sent unprompted and when
```

Every table has `user_id TEXT DEFAULT 'local'` for future multi-tenancy.

## iMessage account setup

Alfred runs as a separate macOS user (`alfred`) who has a dedicated Apple ID (`madsoccerfeet@gmail.com`) signed into Messages. The main user (`shivamgarg`) runs the dev tools but the Alfred process must run as the `alfred` user to read `~/Library/Messages/chat.db` without permission issues.

## Environment variables

See `.env.example` for all vars. Critical ones:

```
ALFRED_PHONE          # Apple ID Alfred listens on
USER_PHONE            # Your number Alfred replies to
OPENAI_API_KEY        # Also used for Gemini/Groq if LLM_BASE_URL is set
LLM_MODEL             # default: gpt-4o-mini
EXTRACTION_MODEL      # default: gpt-4o-mini (can be cheaper/faster)
DB_PATH               # SQLite path — must be writable by alfred macOS user
IMESSAGE_DB_PATH      # Path to alfred user's Messages chat.db
TODOIST_API_TOKEN     # Optional
QUIET_HOURS_START     # Hour (0-23) Alfred stops sending proactive messages
QUIET_HOURS_END       # Hour (0-23) Alfred starts again
```

## Common issues

**`Cannot open database because the directory does not exist`** — Either the `IMESSAGE_DB_PATH` is wrong or the process isn't running as the `alfred` user.

**`attempt to write a readonly database`** — `DB_PATH` points somewhere the current user can't write. Set `DB_PATH=/Users/alfred/alfred.db`.

**ChromaDB embedding warning** — Fixed: we use `OpenAIEmbeddings` class in `vectors.ts` instead of ChromaDB's default.

**Extractor parse fails** — The LLM returned wrong JSON shape. The extraction schema is resilient (filters bad reminders/tasks rather than crashing) but if facts are empty, check the raw LLM output in the `[extractor] Parse failed` log.

**Messages not appearing** — Check that the `alfred` macOS user is logged in (fast user switching) and Messages.app is open and signed in there.
