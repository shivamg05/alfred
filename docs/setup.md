# Alfred: Setup Guide

## Prerequisites

| Requirement | Install |
|---|---|
| macOS | Required — iMessage is Mac-only |
| Node.js 20+ | [nodejs.org](https://nodejs.org) or `brew install node` |
| pnpm | `npm install -g pnpm` |
| ffmpeg | `brew install ffmpeg` |
| pipx | `brew install pipx && pipx ensurepath` |
| ChromaDB | `pipx install chromadb` |

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

# AI — get a key at platform.openai.com
OPENAI_API_KEY=sk-...

# Storage — DB_PATH must be writable by the alfred macOS user
DB_PATH=/Users/alfred/alfred.db
IMESSAGE_DB_PATH=/Users/alfred/Library/Messages/chat.db

# Optional
TODOIST_API_TOKEN=...                 # from todoist.com/app/settings/integrations/developer

# Behaviour
QUIET_HOURS_START=23                  # Alfred stops proactive messages at 11pm
QUIET_HOURS_END=8                     # Alfred starts again at 8am
USER_TIMEZONE=America/Chicago
```

**Using Gemini Flash instead of OpenAI** (cheaper — get a free key at [aistudio.google.com](https://aistudio.google.com)):
```bash
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
OPENAI_API_KEY=<Gemini API key>
LLM_MODEL=gemini-2.0-flash
EXTRACTION_MODEL=gemini-2.0-flash
```
Note: audio transcription and image vision are still hardcoded to OpenAI — you'll need an OpenAI key for those features even if using Gemini for chat.

---

## Step 6: Grant Full Disk Access

imessage-kit needs to read the Messages database.

System Settings → Privacy & Security → Full Disk Access → click "+" → add your terminal app (Terminal, iTerm2, Warp, etc.)

Restart your terminal after granting access.

---

## Step 7: Grant alfred user access to Messages database

The Alfred process runs as the `alfred` macOS user and reads its own Messages database. You need to give the `alfred` user access to the project directory so it can write its own database file.

The `DB_PATH=/Users/alfred/alfred.db` in your `.env` handles this — Alfred writes its memory database to the alfred user's home, where it has full write access. No extra permissions needed.

---

## Step 8: Run

**Terminal 1** — start ChromaDB (the vector store):
```bash
chroma run --path /Users/shivamgarg/dev/alfred/chroma_data
```

**Terminal 2** — switch to the alfred macOS user and start Alfred:

Either use fast user switching to open a terminal as the alfred user, or use `su`:

```bash
su - alfred
cd /path/to/alfred   # wherever you cloned the repo
/opt/homebrew/bin/node --import ./node_modules/tsx/dist/esm/index.cjs src/index.ts
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

## Troubleshooting

**`Cannot open database because the directory does not exist`**
- Check `IMESSAGE_DB_PATH` — verify the path exists: `sudo ls /Users/alfred/Library/Messages/`
- Make sure you're running the process as the `alfred` macOS user, not your main user

**`attempt to write a readonly database`**
- `DB_PATH` points somewhere your current user can't write
- Fix: set `DB_PATH=/Users/alfred/alfred.db` (alfred's home directory)

**Alfred receives messages but doesn't reply**
- Wrap the handler in try-catch to see the actual error (already done in the code)
- Check for `[alfred] handler error:` in the terminal

**Extractor not storing facts**
- Check for `[extractor] Parse failed:` — the LLM returned wrong JSON
- Facts only get stored for messages with real content — short/casual messages return `facts: []` which is correct

**ChromaDB warnings about DefaultEmbeddingFunction**
- Already fixed — we use `OpenAIEmbeddings` class directly. Make sure you're on the latest code.

**Messages not appearing in alfred user's Messages app**
- Switch to the alfred user and open Messages — it may need to be running for iMessage sync
- Verify Alfred's Apple ID is signed in: Messages → Settings → iMessage

---

## Keeping Alfred running

For now, Alfred runs in a terminal tab. To keep it alive across Mac restarts or session disconnects, add it to `pm2` or create a `launchd` plist — documentation for this is in `docs/ops.md` (coming soon).
