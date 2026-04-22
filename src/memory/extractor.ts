import OpenAI from "openai";
import { z } from "zod";
import { config } from "../config.js";
import {
  insertFact,
  insertRelation,
  markSuperseded,
  insertReminder,
  updateChromaId,
  upsertProfileFact,
  getStaticProfileFacts,
  getDynamicProfileFacts,
  searchFactsFTS,
} from "./facts.js";
import { upsertFact as chromaUpsert } from "./vectors.js";
import { createTask } from "../integrations/todoist.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const factSchema = z
  .object({
    // model sometimes returns "fact" instead of "text" — accept both
    text: z.string().optional(),
    fact: z.string().optional(),
    is_static: z.boolean(),
    forget_after: z.string().optional(),
    event_date: z.string().optional(),
    contradicts_hint: z.string().optional(),
  })
  .transform((d) => ({
    text: (d.text ?? d.fact ?? "").trim(),
    is_static: d.is_static,
    forget_after: d.forget_after,
    event_date: d.event_date,
    contradicts_hint: d.contradicts_hint,
  }))
  .refine((d) => d.text.length > 0, { message: "fact must have non-empty text" });

const reminderSchema = z.object({
  text: z.string(),
  due_at: z.string(),
});

const todoistTaskSchema = z.object({
  content: z.string(),
  due_string: z.string().optional(),
});

const extractionSchema = z
  .object({
    facts: z.array(z.unknown()).default([]),
    reminders: z.array(z.unknown()).default([]),
    todoist_tasks: z.array(z.unknown()).default([]),
    follow_up_reminders: z.array(z.unknown()).default([]),
  })
  .transform((data) => ({
    facts: data.facts
      .map((f): z.infer<typeof factSchema> | null => {
        // LLM sometimes returns plain strings instead of objects — normalise them
        if (typeof f === "string") {
          const text = f.trim();
          return text
            ? { text, is_static: false, forget_after: undefined, event_date: undefined, contradicts_hint: undefined }
            : null;
        }
        const r = factSchema.safeParse(f);
        return r.success ? r.data : null;
      })
      .filter((f): f is z.infer<typeof factSchema> => f !== null && f.text.length > 0),
    reminders: data.reminders
      .map((r) => reminderSchema.safeParse(r))
      .filter((r) => r.success)
      .map((r) => (r as { success: true; data: { text: string; due_at: string } }).data),
    todoist_tasks: data.todoist_tasks
      .map((t) => todoistTaskSchema.safeParse(t))
      .filter((t) => t.success)
      .map(
        (t) =>
          (t as { success: true; data: { content: string; due_string?: string } }).data,
      ),
    follow_up_reminders: data.follow_up_reminders
      .map((r) => reminderSchema.safeParse(r))
      .filter((r) => r.success)
      .map((r) => (r as { success: true; data: { text: string; due_at: string } }).data),
  }));

// ---------------------------------------------------------------------------
// LLM client
// ---------------------------------------------------------------------------

let _client: OpenAI | null = null;
function llm(): OpenAI {
  if (!_client) {
    const cfg = config();
    _client = new OpenAI({
      apiKey: cfg.OPENAI_API_KEY,
      ...(cfg.LLM_BASE_URL ? { baseURL: cfg.LLM_BASE_URL } : {}),
    });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// System prompt — aggressive, 5-category extraction
// ---------------------------------------------------------------------------

function buildExtractionPrompt(documentDate: string, existingFacts: string[]): string {
  const existingSection = existingFacts.length > 0
    ? `\nWHAT YOU ALREADY KNOW (do NOT re-extract these unless they changed):\n${existingFacts.map(f => `- ${f}`).join("\n")}\n`
    : "";

  return `You extract structured memory from one or more personal iMessages. The user is texting a personal AI journal about their life.

IMPORTANT: Extract aggressively. Better to over-extract than miss something. If a message contains genuinely NEW information, extract it. Skip anything already captured in "What you already know".
${existingSection}
Today's datetime: ${documentDate}

Return a JSON object — all fields required (use empty arrays if nothing applies):
{
  "facts": [...],
  "reminders": [...],
  "todoist_tasks": [...],
  "follow_up_reminders": [...]
}

═══════════════════════
FACTS — each fact MUST be a JSON object, not a string:
  { "text": "User ...", "is_static": true/false }
5 categories:
═══════════════════════

1. PROFILE (stable, long-term — is_static: true)
   Who they are: occupation, school, location, relationships, identity
   "I work at Google" → "User works at Google"
   "I'm a junior at MIT" → "User attends MIT as a junior"
   "my girlfriend Sarah" → "User has a girlfriend named Sarah"

2. CURRENT CONTEXT (temporary state — is_static: false)
   Active projects, current goals, ongoing priorities, current life situation
   "working on a startup called Life Sim" → "User is building a startup called Life Sim"
   "taking a gap semester in the fall" → "User is taking a gap semester in fall 2026"
   "my life is split between X, Y, Z" → one summary fact + one fact per item

3. PREFERENCES (stable — is_static: true)
   What they like, hate, value, how they operate
   "I hate commuting" → "User dislikes commuting"
   "I always work late" → "User tends to work late"

4. EVENTS (things that happened or will happen — is_static: false)
   Past/upcoming milestones, deadlines, trips, meetings
   event_date: REQUIRED — extract specific date or best estimate
   "internship this summer" → event_date: "${new Date().getFullYear()}-06-01"
   "conference next month" → event_date: estimate from today

5. UPDATES (corrects/supersedes a prior fact — is_static: depends)
   "I changed my mind", "actually I'm doing Y instead of X now"
   contradicts_hint: short phrase from the OLD fact being replaced
   IMPORTANT: set contradicts_hint on the NEW fact only. Do NOT create a separate fact about what the user "previously said" or "used to think".

═══════════════════════
EXTRACTION RULES:
═══════════════════════
- Third person always: "User" not "I"
- ONE fact per entry — never bundle. "doing X and Y" → two separate facts
- LISTS = multiple facts. "my life has 3 parts: A, B, C" → 4 facts (3 items + 1 summary)
- Names of people → "User's [relationship] is named [Name]"
- Projects/startups/companies → always extract, include name if given
- is_static: true for stable identity/preferences, false for current situations/events
- forget_after: set for temporary facts. event_date + 8 weeks, or today + 3 weeks for vague ongoing states
- Lean toward extraction. A slightly redundant fact is fine. A missed fact is bad.
- DO NOT extract meta/conversational noise: "User is discussing X", "User is asking about Y", "User is wondering about Z", "User joked that...", "User is asking for advice on..." — these add no lasting memory value. Only extract facts about their actual life, opinions, plans, or identity.

═══════════════════════
REMINDERS — only explicit asks:
═══════════════════════
Triggers: "remind me", "don't let me forget", "ping me at X"
due_at: ISO8601 datetime (use today's date + time context to compute)

═══════════════════════
TODOIST_TASKS — implicit future intent:
═══════════════════════
Triggers: "i need to", "i have to", "gotta", "should probably", "need to get"
content: short actionable title
due_string: natural language date ONLY if user mentioned one ("tomorrow", "next monday", "in 3 days"). OMIT entirely if no date was given — do NOT write "no specific due date" or similar.

═══════════════════════
FOLLOW_UP_REMINDERS — deferred plans:
═══════════════════════
Triggers: "wanna X later", "gonna X later", "planning to X", "meant to X"
Alfred creates a check-in: "hey did you ever [X]?"
due_at estimate: "later"=+4h, "tonight"=9pm today, "tomorrow"=next 9am, "this week"=+3days 9am

If truly nothing extractable: {"facts":[],"reminders":[],"todoist_tasks":[],"follow_up_reminders":[]}`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function extractFromMessage(opts: {
  messageText: string;
  messageId: number;
  documentDate: string;
}): Promise<void> {
  const cfg = config();
  console.log(`[extractor] running on message ${opts.messageId} (${opts.messageText.length} chars)`);

  // Fetch existing profile so the model can skip duplicates and flag updates
  const existingFacts = [...getStaticProfileFacts(), ...getDynamicProfileFacts()];

  let raw: string;
  try {
    const response = await llm().chat.completions.create({
      model: cfg.EXTRACTION_MODEL,
      messages: [
        { role: "system", content: buildExtractionPrompt(opts.documentDate, existingFacts) },
        { role: "user", content: opts.messageText },
      ],
      max_tokens: 1500,
      response_format: { type: "json_object" },
    });
    raw = response.choices[0]?.message?.content ?? "{}";
    console.log(`[extractor] raw: ${raw.slice(0, 300)}`);
  } catch (err) {
    console.error("[extractor] LLM call failed:", err);
    return;
  }

  let parsed: z.infer<typeof extractionSchema>;
  try {
    parsed = extractionSchema.parse(JSON.parse(raw));
  } catch (err) {
    console.error("[extractor] parse failed:", raw, err);
    return;
  }

  console.log(
    `[extractor] extracted: ${parsed.facts.length} facts, ${parsed.reminders.length} reminders, ` +
    `${parsed.todoist_tasks.length} tasks, ${parsed.follow_up_reminders.length} follow-ups`,
  );

  // --- Explicit reminders ---
  for (const reminder of parsed.reminders) {
    try {
      insertReminder({
        text: reminder.text,
        due_at: reminder.due_at,
        source_message_id: opts.messageId || undefined,
      });
      console.log(`[extractor] reminder: "${reminder.text}" at ${reminder.due_at}`);
    } catch (err) {
      console.error(`[extractor] reminder insert failed:`, err);
    }
  }

  // --- Inferred follow-up reminders ---
  for (const reminder of parsed.follow_up_reminders) {
    try {
      insertReminder({
        text: reminder.text,
        due_at: reminder.due_at,
        source_message_id: opts.messageId || undefined,
      });
      console.log(`[extractor] follow-up reminder: "${reminder.text}" at ${reminder.due_at}`);
    } catch (err) {
      console.error(`[extractor] follow-up reminder insert failed:`, err);
    }
  }

  // --- Memory facts ---
  for (const fact of parsed.facts) {
    console.log(`[extractor] fact: "${fact.text}" (static=${fact.is_static})`);
    try {
      const factId = insertFact({
        text: fact.text,
        is_static: fact.is_static,
        document_date: opts.documentDate,
        event_date: fact.event_date,
        forget_after: fact.forget_after,
        source_message_id: opts.messageId || undefined,
      });

      // Contradiction resolver — if the model flagged this as superseding an
      // existing fact, find it via FTS5 and write the versioning chain.
      if (fact.contradicts_hint) {
        try {
          const candidates = searchFactsFTS(fact.contradicts_hint, 5).filter(
            (c) => c.id !== factId,
          );
          if (candidates.length > 0) {
            const old = candidates[0];
            insertRelation(factId, old.id, "updates");
            markSuperseded(old.id);
            console.log(`[extractor] superseded fact ${old.id}: "${old.text}"`);
          }
        } catch (err) {
          console.error(`[extractor] contradiction resolver failed:`, err);
        }
      }

      try {
        const chromaId = await chromaUpsert(factId, fact.text, {
          is_static: fact.is_static,
          document_date: opts.documentDate,
          ...(fact.event_date ? { event_date: fact.event_date } : {}),
          user_id: config().USER_ID,
        });
        updateChromaId(factId, chromaId);
      } catch (err) {
        console.error(`[extractor] ChromaDB upsert failed for "${fact.text}":`, err);
      }

      try {
        upsertProfileFact({
          fact: fact.text,
          is_static: fact.is_static,
          source_fact_id: factId,
        });
      } catch (err) {
        console.error(`[extractor] profile upsert failed for "${fact.text}":`, err);
      }
    } catch (err) {
      console.error(`[extractor] insertFact failed for "${fact.text}":`, err);
    }
  }

  // --- Implicit Todoist task creation ---
  for (const task of parsed.todoist_tasks) {
    try {
      const created = await createTask({
        content: task.content,
        due_string: task.due_string,
      });
      if (created) {
        console.log(`[todoist] created task: "${task.content}"`);

        // Mirror the task as a local reminder so Alfred's proactive engine fires it.
        // Use the task's due date at 9am, or now+30min if the due date is already today
        // and 9am has passed.
        try {
          let due_at: string;
          if (created.due?.date) {
            const nineAm = new Date(`${created.due.date}T09:00:00`);
            const thirtyMinsFromNow = new Date(Date.now() + 30 * 60 * 1000);
            due_at = nineAm > new Date() ? nineAm.toISOString() : thirtyMinsFromNow.toISOString();
          } else {
            // No due date returned — remind in 30 minutes as a gentle nudge
            due_at = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          }
          insertReminder({
            text: task.content,
            due_at,
            source_message_id: opts.messageId || undefined,
          });
          console.log(`[todoist] reminder set for "${task.content}" at ${due_at}`);
        } catch (err) {
          console.error(`[extractor] reminder for todoist task failed:`, err);
        }
      }
    } catch (err) {
      console.error(`[extractor] todoist task creation failed:`, err);
    }
  }

  console.log(`[extractor] done for message ${opts.messageId}`);
}
