# Alfred — Codebase Guide for Codex

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

Visualize the memory graph:
```bash
pnpm memory
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
| `src/memory/retrieval.ts` | Layered retrieval: identity anchors, bedrock patterns, RRF detail, upward `instance_of` expansion, source chunks |
| `src/memory/consolidation.ts` | Periodic memory consolidation: expires level-0 facts, promotes clusters into level-1/level-2 memories |
| `src/orchestrator/context.ts` | `fetchContext()` (retrieval, mode-independent) + `buildPrompt()` (assembles system prompt) |
| `src/orchestrator/classifier.ts` | Intent classifier: `silent \| brief \| full`. Fires non-blocking in parallel with retrieval. 5s timeout. |
| `src/orchestrator/llm.ts` | Multi-iteration tool-calling loop (max 8 turns). Tools run in parallel via Promise.all |
| `src/tone/systemPrompt.ts` | Alfred's personality + mode-aware length rules + NOW timestamp injection |
| `src/proactive/engine.ts` | All proactive crons: per-minute (reminders + nudges + catch-up), 6h consolidation + pattern obs, weekly promote, 9am brief, 1pm external synthesis, 5pm absence reflection, 7pm wrap. Also `src/proactive/judge.ts` (LLM judge) and `src/proactive/gate.ts` (quiet hours + 3h gap). |
| `src/integrations/todoist.ts` | Todoist API v1: list (with filters), create, close, update tasks |
| `src/tools/registry.ts` | Tool definitions (OpenAI schema) + dispatcher. Logs both call and result |
| `src/tools/web.ts` | Firecrawl v2 search + scrape. Rewrites Twitter/X URLs to fxtwitter.com |
| `src/tools/todoist.ts` | Tool dispatch layer over `integrations/todoist.ts` |
| `src/ingestion/attachments.ts` | WAL-race fallback: queries chat.db directly for attachments. `resolveAttachments()` returns all. |
| `scripts/memory-graph.ts` | CLI visualizer: shows facts, edge counts, bedrock nodes, relates_to graph |
| `scripts/backfill-graph.ts` | One-time script: embeds unembedded facts and wires relates_to edges retroactively |

## Memory layer

Three tiers assembled into every context window:

1. **Short-term** — `ConversationBuffer` in process memory. Last 20 messages, resets after 4h silence
2. **Working memory** — SQLite. Active reminders + user profile (static and dynamic facts)
3. **Long-term** — ChromaDB + FTS5. Every extracted fact, searchable semantically and by keyword

### Knowledge graph

Facts are immutable nodes with `abstraction_level`: `0` specific event/state/plan, `1` behavioral pattern, `2` identity/value. `fact_relations` rows are edges. `relates_to` is undirected and canonicalized; all other edge types are directed with `fact_id_a = source`, `fact_id_b = target`. `instance_of` is vertical and adjacent-level only (`L0 -> L1`, `L1 -> L2`). `updates` keeps old children as history; `extends` rewires children to the refined fact. Full rules are in `docs/memory.md`.

**Identity facts** — latest level-2 facts, always injected once as core identity.

**Bedrock facts** — top level-1 patterns ranked by `descendant_count / (1 + age_days * 0.05)`. Always injected as foundational patterns.

**Graph expansion** — after RRF retrieval, top hits first walk upward through `instance_of` parents, then use a small `relates_to` lateral budget.

### Extraction (session-based)

Messages are buffered (up to 5, or 2 min idle) then extracted as a batch. The extractor:
- Injects existing profile facts + FTS-matched topical facts so the model skips near-duplicates
- Pre-insertion guard: skips facts with ChromaDB distance < 0.15 to an existing fact
- Assigns `abstraction_level` and enforces `forget_after` only for level-0 facts
- Auto-wires `instance_of` parent edges via hints/semantic parent search
- Auto-wires same-level `relates_to` edges for new facts with similarity 0.12–0.55 to existing facts
- Extracts across 5 categories: Profile, Current Context, Preferences, Events, Updates
- Handles `contradicts_hint` as `updates` and `extends_hint` as `extends`
- Mirrors every created Todoist task as a local reminder

### Retrieval (hybrid RRF)

At response time, ChromaDB (semantic) and FTS5 (BM25 keyword) are both queried. Results merged via Reciprocal Rank Fusion with recency + upcoming-event boosts, then annotated with source message snippets.

## LLM calls

All LLM calls go through the OpenAI SDK pointed at `LLM_BASE_URL`. Currently: OpenRouter (`https://openrouter.ai/api/v1`). Model IDs use OpenRouter's namespaced format (`openai/gpt-4o-mini`).

- **Responses**: `chat()` in `orchestrator/llm.ts` — multi-turn tool loop, `LLM_MODEL`, max 200 tokens
- **Classifier**: `classifyWithTimeout()` in `orchestrator/classifier.ts` — `EXTRACTION_MODEL`, fires in parallel with retrieval, 5s timeout → "brief"
- **Extraction**: `extractFromMessage()` in `memory/extractor.ts` — `EXTRACTION_MODEL`, max 1500 tokens
- **Proactive**: `generateProactive()` in `orchestrator/llm.ts` — `LLM_MODEL`, max 150 tokens
- **Embeddings**: `vectors.ts` — routes through `LLM_BASE_URL`, model `openai/text-embedding-3-small`
- **Transcription**: `transcribeAudio()` — `google/gemini-2.5-flash-lite` via OpenRouter, base64 WAV via `input_audio`; audio converted from CAF using macOS `afconvert`
- **Image**: `summarizeImageFromPath()` — vision model via OpenRouter (`anthropic/Codex-haiku-4-5`); HEIC converted to JPEG via `heic-convert`; supports multiple images in parallel

## Response flow

```
message arrives
  → classifyWithTimeout() fires immediately (non-blocking)
  → 1s debounce window
  → Promise.all([classifier, fetchContext()])   ← parallel
  → buildPrompt(contextData, mode)
  → silent (30% chance) → send random ack
  → brief/full → chat() tool loop → sendBubbles()
  → always → queueForExtraction() → session buffer → extractFromMessage()
```

## Tone / personality

`src/tone/systemPrompt.ts` is the only place Alfred's personality is defined. Key rules:
- Lowercase, no em dashes, minimal punctuation
- Direct and opinionated — commits to takes, doesn't hedge
- Swears when it fits naturally, not constantly
- `brief` mode: 1 sentence, ≤20 words. `full` mode: max 2 bubbles, ≤25 words each
- `[SPLIT]` between bubbles, 1500ms delay in `orchestrator/response.ts`
- Current datetime injected at top of every prompt (user's timezone from `USER_TIMEZONE`)

## SQLite schema summary

```
messages            — raw + transcript/summary, imessage_row_id
memory_facts        — atomic facts, abstraction_level, descendant_count, is_latest, forget_after, chroma_id
                      proactive_after, proactive_fired_at, pattern_observation_queued
memory_facts_fts    — FTS5 virtual table (auto-synced via triggers)
fact_relations      — instance_of | relates_to | updates | extends | derives | consolidated_from
reminders           — due_at, fired_at (includes mirrored Todoist tasks)
user_profile        — materialized static + dynamic facts (key/value)
proactive_log       — what Alfred sent unprompted and when (source_fact_id links to triggering fact)
proactive_attempts  — every proactive attempt logged: sent | skipped | blocked | error
cron_state          — last_ran_at per named cron job, used for Mac-sleep catch-up recovery
```

Every table has `user_id TEXT DEFAULT 'local'` for future multi-tenancy.

## iMessage account setup

Alfred runs as a separate macOS user (`alfred`) who has a dedicated Apple ID (`madsoccerfeet@gmail.com`) signed into Messages. The main user (`shivamgarg`) runs the dev tools but the Alfred process must run as the `alfred` user to read `~/Library/Messages/chat.db` without permission issues.

## Environment variables

See `.env.example` for all vars. Critical ones:

```
ALFRED_PHONE          # Apple ID Alfred listens on
USER_PHONE            # Your number Alfred replies to
OPENAI_API_KEY        # Used as the API key for LLM_BASE_URL (OpenRouter key if using OpenRouter)
LLM_BASE_URL          # OpenAI-compatible base URL (e.g. https://openrouter.ai/api/v1)
LLM_MODEL             # default: gpt-4o-mini
EXTRACTION_MODEL      # default: gpt-4o-mini (can be cheaper/faster)
DB_PATH               # SQLite path — must be writable by alfred macOS user
IMESSAGE_DB_PATH      # Path to alfred user's Messages chat.db
TODOIST_API_TOKEN     # Optional
QUIET_HOURS_START     # Hour (0-23) Alfred stops sending proactive messages
QUIET_HOURS_END       # Hour (0-23) Alfred starts again
USER_TIMEZONE         # IANA timezone (e.g. America/New_York) — controls cron schedule + prompt timestamps
```

## Common issues

**`Cannot open database because the directory does not exist`** — Either the `IMESSAGE_DB_PATH` is wrong or the process isn't running as the `alfred` user.

**`attempt to write a readonly database`** — `DB_PATH` points somewhere the current user can't write. Set `DB_PATH=/Users/alfred/alfred.db`.

**ChromaDB embedding warning** — Fixed: we use `OpenAIEmbeddings` class in `vectors.ts` instead of ChromaDB's default.

**Extractor parse fails** — The LLM returned wrong JSON shape. The extraction schema is resilient (filters bad reminders/tasks rather than crashing) but if facts are empty, check the raw LLM output in the `[extractor] Parse failed` log.

**Messages not appearing** — Check that the `alfred` macOS user is logged in (fast user switching) and Messages.app is open and signed in there.

**Audio transcription 500 error** — OpenRouter does not support `/v1/audio/transcriptions`. Transcription uses `google/gemini-2.5-flash-lite` with base64 `input_audio` via chat completions instead.
