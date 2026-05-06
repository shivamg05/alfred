# Alfred Proactive Messaging

## Philosophy

Proactive messages are what make Alfred feel alive rather than reactive. The standard for sending one is high: it should feel like something a close friend would have actually thought to say, not something a reminder app would have generated. The bar is *magical* — a message that makes the user think "how did it know to say that right now?"

There are four distinct triggers for proactivity. Each has its own timing, tone, and quality gate. They are not interchangeable.

## One-at-a-time constraint

Only one proactive message can be sent at a time. The `proactive_log` table records every sent message. The gate checks `getLastProactiveSentAt()` and enforces a **3-hour minimum gap** between any two proactive messages, regardless of type.

Priority ordering (highest wins when multiple are ready simultaneously):

1. **Reminders** — strictly-due reminders (per-minute cron) always fire and bypass the gate entirely. Message-triggered reminders (opportunistic 1h window when a conversation is active) still check the gate to avoid interrupting unexpectedly early.
2. **L0 Nudges** — fires when proactive_after is past due
3. **Morning brief / Evening wrap** — scheduled check-ins
4. **L1 Pattern Observation** — milestone-triggered, LLM-judged
5. **External Synthesis** — daily, web-searched, LLM-judged
6. **Absence Reflection** — daily, stale bedrock check

In practice, the 3-hour gate naturally serializes these. Reminders bypass the gate entirely.

## Rate limiting

- Minimum 3 hours between any two non-reminder proactive messages (enforced by gate)
- Quiet hours: configurable `QUIET_HOURS_START` to `QUIET_HOURS_END` (default: midnight–8am)
- Per-type constraints: Type 2 sends at most 1 message per 6-hour cron run even if many L1 facts are queued

---

## Type 1 — L0 Nudge

**Trigger:** A L0 fact is extracted with a `proactive_nudge.after_hours` field. The extractor sets `proactive_after` on the fact row. The per-minute cron fires when `proactive_after <= now` and `proactive_fired_at IS NULL`.

**When to create:** The extractor looks for unfulfilled intentions and tensions:
- Intentions: "I need to call my advisor", "gonna reach out to that recruiter" → `after_hours: 36`
- Same-day tensions: "I'm stressed about this deadline", "been putting off X" → `after_hours: 8`
- NOT for: completed actions, neutral observations, events with their own event_date

**Tone:** Direct, friend-like. "hey, did you ever reach out to that recruiter?" — not a robotic reminder.

**Gate:** Goes through the standard 3-hour gate (quiet hours apply). Fact is marked `proactive_fired_at` whether the gate allows or blocks (so it doesn't repeatedly try).

**Schema fields added:**
- `memory_facts.proactive_after TEXT` — ISO8601 datetime to trigger
- `memory_facts.proactive_fired_at TEXT` — when the nudge was processed (set regardless of gate outcome)

---

## Type 2 — L1 Pattern Observation

**Trigger:** A L1 fact's `descendant_count` crosses a milestone threshold (3, 5, 8, 12, or 20 descendants). When this happens, `pattern_observation_queued = 1` is set atomically during the `propagateDescendantIncrement` update.

**Milestones** represent structurally significant moments: a pattern isn't noise anymore at 3 instances, it's well-established at 8, it's definitional at 20.

**Cron:** Every 6 hours. Runs alongside `consolidateExpiredLevel0`.

**Flow:**
1. Fetch all L1 facts with `pattern_observation_queued = 1`
2. For each queued fact, generate a candidate message (what would Alfred naturally say about noticing this pattern?)
3. Score each candidate through the LLM judge (0–100)
4. Pick the highest-scoring candidate above threshold 70
5. Run through the 3-hour gate
6. If allowed, send and log with `source_fact_id`
7. Clear ALL `pattern_observation_queued` flags after the run (whether or not a message was sent)

**Schema fields added:**
- `memory_facts.pattern_observation_queued INTEGER DEFAULT 0`
- `proactive_log.source_fact_id INTEGER REFERENCES memory_facts(id)`

**Tone:** Observational but human, not analytical. "u've been grinding thru a lot of anxious commitments lately, is that getting better or worse?" Not: "I've noticed a pattern in your behavior."

---

## Type 3 — External Synthesis

**Trigger:** Daily cron (1pm). Runs every day.

**Flow:**
1. Get L2 identity facts + top 5 L1 bedrock facts (by bedrock score)
2. For each L2 fact, generate a recency-biased web search query (what's new/happening related to this aspect of their identity?)
3. Run the top 2–3 queries via `search_web`
4. Synthesize results into a short, interesting message — something the user would actually care about given who they are
5. Include a URL when the source is useful
6. Score through LLM judge (0–100, threshold 70)
7. Run through 3-hour gate, send if allowed

**Recency bias:** Queries should be phrased to surface recent/current information ("latest news about X", "what happened recently with Y") rather than timeless facts.

**Scope:** L2 facts define *what to search for*. L1 bedrock facts provide *framing context* for the judge (is this actually relevant to how this person lives?).

**Tone:** Casual share, not a news briefing. "btw [article/thing] happened — seems super relevant to what you're building" or "saw this and thought of you: [URL]"

---

## Type 4 — Absence Reflection

**Trigger:** Daily cron (5pm). Queries for L1 bedrock facts that haven't been the subject of a proactive message (via `source_fact_id` in `proactive_log`) in the last 14 days.

**Staleness:** A bedrock pattern is "stale" when Alfred hasn't proactively engaged with it in 2 weeks. These are the important recurring themes in the user's life that can easily get crowded out by daily noise.

**Dedup:** Skip facts that already had a proactive message in the last 14 days (via `proactive_log.source_fact_id` join). Pick the highest-priority stale fact (bedrock score). Up to 3 facts are tried in priority order; the first that passes the LLM judge is sent.

**Bootstrapping note:** On first deployment after v5, `proactive_log` rows written before the schema migration have `source_fact_id = NULL` and won't count as "recently mentioned." This means absence reflection may surface topics Alfred mentioned pre-v5. The dedup becomes accurate after 14 days of operation under v5.

**Tone:** Directive and direct, not question-heavy. "you haven't mentioned [gym / the startup / X] in a while — where are you at with that?" One question max. Feels like a check-in from a friend who pays attention.

---

## LLM-as-Judge

Types 2, 3, and 4 use an LLM judge before sending. The judge scores a candidate message 0–100 based on:
- **Relevance** (0–40): Is this actually about something that matters to this person right now?
- **Timing** (0–30): Does this feel timely — not stale, not premature?
- **Tone** (0–30): Does this sound like something a close friend would say, not a bot?

Threshold: **70** to send. Below 70 = skip.

The judge receives:
- The candidate message text (the synthesized output, not the raw search results)
- A context string: the user's L2 identity facts + top L1 bedrock facts

The judge is fast (single call, max 50 tokens response: `{"score": 73, "reason": "timely and relevant to..."}`).

---

## Cron Schedule

| Schedule | Job |
|---|---|
| `* * * * *` | Fire due reminders + due L0 nudges + catch-up check |
| `17 */6 * * *` | Consolidate expired L0 facts |
| `20 */6 * * *` | L1 Pattern Observation (Type 2) |
| `30 3 * * 0` | Weekly: promote L1 patterns to L2 |
| `0 9 * * *` | Morning brief |
| `0 13 * * *` | External Synthesis (Type 3) |
| `0 17 * * *` | Absence Reflection (Type 4) |
| `0 19 * * *` | Evening wrap |

All cron schedules use `{ timezone: USER_TIMEZONE }` so they fire at the configured local time regardless of the system clock's timezone.

---

## Catch-up on Missed Crons

Alfred runs on a Mac that may sleep. node-cron does not re-run missed ticks — a job scheduled at 9:00am is simply skipped if the process was suspended. The per-minute cron runs a `checkMissedCrons` pass on every tick to recover these.

**Daily jobs** (morning brief, external synthesis, absence reflection, evening wrap) are caught up if:
1. The current local hour falls within a 4-hour window starting at the scheduled hour (e.g., 9am–12:59pm for morning brief, 1pm–4:59pm for external synthesis)
2. The job hasn't run in the last 23 hours

**6-hourly jobs** (consolidate_l0, pattern_observation) are caught up if the job hasn't run in the last 6 hours.

**Catch-up does not fire** when `cron_state` has no row for the job (null `last_ran_at`). First-run is always owned by the scheduled cron, not catch-up. This prevents both 6-hourly jobs from eagerly firing on every cold start.

**Atomic slot claiming:** `cron_state` uses a conditional SQLite upsert so both the scheduled cron and a concurrent catch-up check can't double-fire the same job. Only the first writer in a given minute proceeds.

**Late morning/evening messages:** When catch-up fires a morning brief or evening wrap, Alfred opens with a short funny excuse for the delay ("sorry i was walking my fish but..."). This only applies to those two types — the others are spontaneous by nature and don't have a user-expected send time.

**Weekly job (promote_l1) is not caught up.** Its window is too narrow (Sunday 3am) and a missed week is non-critical.

---

## Schema Changes (v5)

```sql
-- New columns on memory_facts
ALTER TABLE memory_facts ADD COLUMN proactive_after TEXT;        -- L0 nudge trigger time
ALTER TABLE memory_facts ADD COLUMN proactive_fired_at TEXT;     -- set when nudge is processed
ALTER TABLE memory_facts ADD COLUMN pattern_observation_queued INTEGER NOT NULL DEFAULT 0;

-- New column on proactive_log
ALTER TABLE proactive_log ADD COLUMN source_fact_id INTEGER REFERENCES memory_facts(id);
```

`pattern_observation_queued` is set atomically in the `propagateDescendantIncrement` SQL UPDATE when a L1 fact's new descendant_count lands on a milestone value (3, 5, 8, 12, 20).

## Schema Changes (v6)

```sql
CREATE TABLE cron_state (
  job_name TEXT PRIMARY KEY,
  last_ran_at TEXT NOT NULL
);
```

`cron_state` records when each named cron job last ran. Used by `checkMissedCrons` to determine whether a job was missed while the Mac was asleep. Cleared by `pnpm memory:reset`.

---

## Key Design Decisions

**Why per-fact proactive_after instead of a separate table?**
The L0 fact is already the right unit of granularity. A separate reminders-like table would duplicate the fact reference and make cleanup harder when facts are forgotten or superseded.

**Why milestone-based queueing instead of polling every N hours?**
Polling would require the system to re-evaluate all L1 facts constantly. Milestones are structurally meaningful moments — they only fire when something real changed in the knowledge graph.

**Why LLM judge instead of pure heuristics?**
Pattern observation and external synthesis are inherently qualitative. Heuristics (has X descendants, last-fired N days ago) can't answer "does this actually feel worth saying right now?" The judge is cheap (small model, 50 tokens) and makes that call explicitly.

**Why clear all pattern_observation_queued after one run?**
To prevent accumulation. If 5 L1 facts hit milestones in one cycle, Alfred picks the best one to say. The others get cleared — they'll re-queue next time they hit the next milestone threshold.

**Why source_fact_id in proactive_log?**
It enables clean dedup queries for Type 4 absence reflection. Without it, you'd have to do fuzzy text matching to determine if a proactive message was "about" a particular L1 fact.

**Why directive tone for Type 4?**
Absence reflection is about reconnecting with things that matter. A question-heavy tone sounds passive and formulaic ("have you thought about X lately?"). A directive opener ("you haven't mentioned the startup in 2 weeks — where's that at?") sounds like a friend who cares and notices.

**Why stamp cron_state before running fn(), not after?**
Pre-stamping is the atomic claim. If the stamp happened after success, two concurrent callbacks (scheduled cron + catch-up check at the same minute) could both read stale `last_ran_at`, both decide to fire, and race through the gate. The conditional upsert (`WHERE last_ran_at < now - 1 minute`) ensures only the first writer proceeds. The tradeoff: if a job is gate-blocked (e.g., external synthesis blocked because morning brief just sent), the slot is still consumed and won't retry for ~23h. This is intentional — Alfred targets one proactive message per 3h max.

**Why atomic claim for reminders before sendBubbles?**
The per-minute cron tick can exceed 60s when `checkMissedCrons` runs LLM-backed jobs. node-cron doesn't serialize callbacks, so the next tick can start before the previous one finishes. By writing `fired_at` before awaiting `sendBubbles` (with `WHERE fired_at IS NULL`), only one tick wins the claim. If `sendBubbles` fails after the claim, the reminder stays marked fired (no retry) — acceptable since reminders are usually non-critical in that exact moment.

**Why protect unfired nudges from consolidation?**
`consolidateExpiredLevel0` marks expired L0 facts as forgotten. But a fact with `proactive_after` set and `proactive_fired_at IS NULL` has a pending nudge — forgetting it makes `getNudgeDueFacts()` skip it (requires `is_forgotten = 0`). The nudge never fires. The fix: `getExpiredLevel0Facts` excludes facts with unfired nudges (`proactive_after IS NOT NULL AND proactive_fired_at IS NULL`). Once the nudge fires and sets `proactive_fired_at`, the fact becomes eligible for normal expiration.

**Why persist proactive messages in the messages table?**
Proactive messages are sent via `sendBubbles` → iMessage, but were never stored in Alfred's own `messages` table or pushed to the `ConversationBuffer`. When the user replied to a proactive message, Alfred had zero context about what it had said — leading to confused, context-free responses. `sendAndPersist` wraps every proactive send with both DB insertion and buffer push. The `[alfred]` prefix in `raw_text` distinguishes Alfred's outbound messages from user inbound messages.

**Why batch multiple simultaneous reminders?**
When the user says "remind me to do A, B, and C at 9am", three reminders fire at the same `due_at`. Sending three separate messages back-to-back feels like spam. `sendBatchReminders` atomically claims all due reminders and combines them into a single bulleted message. Single reminders still get the natural "hey don't forget — ..." phrasing.

**Why 9am → 1pm → 5pm → 7pm spacing?**
The 3-hour gate was systematically blocking external synthesis (was 11am, only 2h after 9am morning brief). The new schedule ensures every daily proactive type has at least 3h clearance: morning brief 9am, external synthesis 1pm (4h gap), absence reflection 5pm (4h gap), evening wrap 7pm (2h gap, but evening wrap doesn't need gate clearance from absence reflection since they're different enough in timing).

**Why timezone-aware due_at in extraction?**
The extractor LLM was generating `09:00:00Z` (UTC) when the user said "9am" — but the user is in America/New_York (UTC-4). The reminder fired at 5am local time or, after the `+2 minutes` buffer, was already past due by evening and fired immediately. Injecting `USER_TIMEZONE` into the extraction prompt and requiring ISO8601 with timezone offset fixes this at the source.

**Why standing behavioral instructions as L1 facts?**
When a user says "call me out when I reward myself instead of working", this is a durable behavioral contract — not a one-time reminder. Previously these were either ignored or incorrectly extracted as reminders. Extracting them as L1 facts means they persist in the knowledge graph, show up in context retrieval, and can be surfaced by absence reflection if Alfred hasn't honored them recently.
