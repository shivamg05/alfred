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
| `src/index.ts` | Entry point. Wires everything: DB init, watcher, cron jobs, message handler |
| `src/config.ts` | All env vars parsed and validated with Zod. Always use `config()` not `process.env` directly |
| `src/db/schema.ts` | SQLite schema. Call `db()` to get the singleton connection |
| `src/memory/facts.ts` | All SQLite reads/writes for facts, reminders, profile, proactive log |
| `src/memory/vectors.ts` | ChromaDB client. Uses OpenAI `text-embedding-3-small` embeddings |
| `src/memory/extractor.ts` | Background LLM call after each message. Extracts facts, reminders, Todoist tasks |
| `src/memory/retrieval.ts` | Hybrid retrieval: semantic (0.5) + recency decay (0.3) + static boost (0.2) |
| `src/orchestrator/context.ts` | Assembles the context window from all 3 memory tiers + Todoist |
| `src/tone/systemPrompt.ts` | The authoritative system prompt. Alfred's personality lives here |
| `src/proactive/engine.ts` | Three cron jobs: 9am brief, 1pm connection, 7pm wrap |
| `src/integrations/todoist.ts` | Todoist REST API v2: read tasks, create tasks |

## Memory layer

Three tiers assembled into every context window:

1. **Short-term** — `ConversationBuffer` in process memory. Last 20 messages, resets after 4h silence
2. **Working memory** — SQLite. Active reminders + user profile (static and dynamic facts)
3. **Long-term** — ChromaDB. Every extracted fact, embedded and searchable

Facts are atomic ("User is building a synthetic humans project"), stored individually, versioned with contradiction detection. New facts that contradict old ones write an `updates` relation and mark the old fact `is_latest = false`.

## LLM calls

All LLM calls go through the OpenAI SDK pointed at `LLM_BASE_URL` (default: OpenAI, but can be Gemini, Groq, etc.).

- **Responses**: `chat()` in `orchestrator/llm.ts` — uses `LLM_MODEL`, max 300 tokens
- **Extraction**: `extractFromMessage()` in `memory/extractor.ts` — uses `EXTRACTION_MODEL`, returns JSON
- **Proactive**: `generateProactive()` in `orchestrator/llm.ts` — uses `LLM_MODEL`, max 150 tokens
- **Transcription**: `transcribeAudio()` in `ingestion/transcription.ts` — hardcoded to OpenAI `whisper-1`
- **Image**: `summarizeImage()` in `ingestion/fileParser.ts` — hardcoded to OpenAI `gpt-4o`
- **Embeddings**: `vectors.ts` — hardcoded to OpenAI `text-embedding-3-small`

## Tone / personality

`src/tone/systemPrompt.ts` is the only place Alfred's personality is defined. Key rules:
- Lowercase, minimal punctuation, no periods at end of texts
- Gen Z patterns ("lol", "ngl", "tbh") used naturally not constantly
- Never "Certainly!", "As an AI", "Great!"
- Max 2 sentences per bubble, use `[SPLIT]` for multiple bubbles
- 800ms delay between bubbles in `orchestrator/response.ts`

## SQLite schema summary

```
messages        — raw + transcript/summary, imessage_row_id
memory_facts    — atomic facts, versioned (root/parent FK), is_latest, is_static, forget_after
fact_relations  — updates | extends | derives
reminders       — due_at, fired_at
user_profile    — materialized static + dynamic facts (key/value)
proactive_log   — what Alfred sent unprompted and when
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
