# Alfred: Setup Guide

## Prerequisites

| Requirement | Install |
|---|---|
| macOS | Required — iMessage is Mac-only |
| Node.js 20+ | [nodejs.org](https://nodejs.org) or `brew install node` |
| pnpm | `npm install -g pnpm` |
| pipx | `brew install pipx && pipx ensurepath` |
| ChromaDB | `pipx install chromadb` |

> **No ffmpeg needed.** Audio transcription uses macOS's built-in `afconvert` (CAF→WAV) and Gemini Flash via chat completions. Image handling uses the `heic-convert` npm package.

---

## Step 1: iMessage Apple ID

Alfred needs its own Apple ID so it has a distinct iMessage address.

1. Go to [appleid.apple.com](https://appleid.apple.com) → Create Apple ID
2. Use a **Gmail address** (not `@icloud.com` — Apple rejects those as the primary email during signup)
3. You'll need a phone number for verification. If your personal number is already linked to your main Apple ID, use [Google Voice](https://voice.google.com) (free US number, takes 2 minutes to set up)
4. Complete signup. The Gmail address is Alfred's iMessage handle

---

## Step 2: Separate macOS user account

macOS Messages only supports one Apple ID at a time. Alfred needs its own user account on your Mac.

1. System Settings → Users & Groups → click "+" → Add Account
2. Type: **Standard**
3. Name it `alfred` (or anything — just remember it)
4. Set a password

**Enable fast user switching** so both accounts can be active simultaneously:
- System Settings → Users & Groups → enable "Fast User Switching"

---

## Step 3: Sign Alfred into Messages

1. Switch to the `alfred` macOS user (fast user switch from menu bar)
2. Open Messages.app
3. Messages → Settings → iMessage → sign in with the Apple ID you created in Step 1
4. Verify the Gmail address is listed under "You can be reached for messages at"

**Test it:** From your iPhone, open a new iMessage conversation, type Alfred's Gmail address as recipient, send "hello". It should appear in Messages on the alfred macOS user.

5. Switch back to your main macOS user account

---

## Step 4: Install Alfred

```bash
git clone https://github.com/shivamg05/alfred.git
cd alfred
pnpm install
```

**Build the native SQLite module** (required once):
```bash
cd node_modules/better-sqlite3
node-gyp configure build
cd ../..
```

If `node-gyp` isn't found: `npm install -g node-gyp`

---

## Step 5: Configure

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# iMessage
ALFRED_PHONE=yourbot@gmail.com        # The Apple ID from Step 1
USER_PHONE=+1xxxxxxxxxx               # Your personal phone number

# AI — get a key at openrouter.ai (recommended) or platform.openai.com
OPENAI_API_KEY=sk-or-...
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=anthropic/claude-haiku-4-5
EXTRACTION_MODEL=google/gemini-2.5-flash-lite

# Storage — DB_PATH must be writable by the alfred macOS user
DB_PATH=/Users/alfred/alfred.db
IMESSAGE_DB_PATH=/Users/alfred/Library/Messages/chat.db

# Optional
TODOIST_API_TOKEN=...                 # from todoist.com/app/settings/integrations/developer
FIRECRAWL_API_KEY=...                 # from firecrawl.dev — enables web search + scraping

# Behaviour
QUIET_HOURS_START=23                  # Alfred stops proactive messages at 11pm
QUIET_HOURS_END=8                     # Alfred starts again at 8am
USER_TIMEZONE=America/Chicago
```

### OpenRouter setup (recommended)

OpenRouter gives you access to Claude, Gemini, and GPT-4 models under one key with no per-model key management.

1. Sign up at [openrouter.ai](https://openrouter.ai)
2. Create an API key
3. Set `OPENAI_API_KEY=<your openrouter key>` and `LLM_BASE_URL=https://openrouter.ai/api/v1`

### Using OpenAI directly

```bash
OPENAI_API_KEY=sk-...
# leave LLM_BASE_URL unset (or delete it)
LLM_MODEL=gpt-4o-mini
EXTRACTION_MODEL=gpt-4o-mini
```

Note: the classifier and ack generator are hardcoded to `google/gemini-2.5-flash-lite` via OpenRouter regardless of your `LLM_MODEL`. If you're not using OpenRouter, set `LLM_BASE_URL` to your provider's base URL and adjust model names accordingly.

---

## Step 6: Grant Full Disk Access

imessage-kit needs to read the Messages database.

System Settings → Privacy & Security → Full Disk Access → click "+" → add your terminal app (Terminal, iTerm2, Warp, etc.)

Restart your terminal after granting access.

---

## Step 7: Run

**Terminal 1** — start ChromaDB (the vector store):
```bash
chroma run --path /path/to/alfred/chroma_data
```

**Terminal 2** — switch to the alfred macOS user and start Alfred:

Either use fast user switching to open a terminal as the alfred user, or:

```bash
su - alfred
/opt/homebrew/bin/node --import /path/to/alfred/node_modules/tsx/dist/esm/index.cjs /path/to/alfred/src/index.ts
```

You should see:
```
[alfred] database ready
[alfred] imessage-kit initialized
[alfred] buffer seeded with 0 messages
[alfred] cron jobs registered
[alfred] watching for messages on yourbot@gmail.com → replying to +1xxxxxxxxxx
```

Text Alfred's Gmail from your iPhone. You should get a reply within ~5 seconds.

---

## Useful commands

```bash
# Type-check without running
pnpm typecheck

# Visualize the memory graph (opens in browser)
pnpm memory:viz -- --serve --open

# Reset learned memory (keeps raw messages)
pnpm memory:reset -- --yes

# Full wipe including messages
pnpm memory:reset -- --yes --include-messages

# Recount descendant_count for all facts (run as alfred user)
node --import ./node_modules/tsx/dist/esm/index.cjs scripts/recount-descendants.ts
```

---

## Troubleshooting

**`Cannot open database because the directory does not exist`**
- Check `IMESSAGE_DB_PATH` — verify the path exists: `sudo ls /Users/alfred/Library/Messages/`
- Make sure you're running the process as the `alfred` macOS user, not your main user

**`attempt to write a readonly database`**
- `DB_PATH` points somewhere your current user can't write
- Fix: set `DB_PATH=/Users/alfred/alfred.db` (alfred's home directory)

**Alfred receives messages but doesn't reply**
- Check for `[alfred] handler error:` in the terminal
- Check the classifier output — `silent` mode means Alfred intentionally didn't respond

**Tool calls show raw XML in iMessage**
- This means the XML tool-call fallback failed to parse the model's output
- Check `[llm]` logs for `xml tool calls — synthetic` to confirm the fallback fired
- If you see raw `<function_calls>` or `<tool_use>` in a sent message, file an issue with the model name and full log

**Extractor not storing facts**
- Check for `[extractor] Parse failed:` — the LLM returned wrong JSON
- Facts only get stored for messages with real personal content — weather checks etc return `facts: []` which is correct

**ChromaDB not connecting**
- Make sure `chroma run --path ./chroma_data` is running in a separate terminal
- Alfred degrades gracefully — FTS5 carries retrieval, but semantic search and embedding won't work

**Messages not appearing in alfred user's Messages app**
- Switch to the alfred user and open Messages — it needs to be running for iMessage sync
- Verify Alfred's Apple ID is signed in: Messages → Settings → iMessage

**Audio transcription failing**
- Alfred uses `afconvert` (built into macOS) to convert CAF to WAV — no extra install needed
- Check for `[transcription] error:` in the logs

---

## Keeping Alfred running

For now, Alfred runs in a terminal tab. To keep it alive across Mac restarts, add it to `pm2`:

```bash
npm install -g pm2
pm2 start /opt/homebrew/bin/node --name alfred -- \
  --import /path/to/alfred/node_modules/tsx/dist/esm/index.cjs \
  /path/to/alfred/src/index.ts
pm2 save
pm2 startup
```
