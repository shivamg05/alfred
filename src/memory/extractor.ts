import { z } from "zod";
import { config } from "../config.js";
import { makeOpenAIClient } from "../orchestrator/llm.js";
import {
  insertFact,
  insertInstanceOfRelation,
  insertRelation,
  markSuperseded,
  insertReminder,
  updateChromaId,
  upsertProfileFact,
  getStaticProfileFacts,
  getDynamicProfileFacts,
  getLevel2Facts,
  getBedrockFacts,
  getFactById,
  searchFactsFTS,
} from "./facts.js";
import { upsertFact as chromaUpsert, querySimilarFacts } from "./vectors.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const factSchema = z
  .object({
    // model sometimes returns "fact" instead of "text" — accept both
    text: z.string().optional(),
    fact: z.string().optional(),
    is_static: z.boolean(),
    abstraction_level: z.coerce.number().int().min(0).max(2).default(1),
    forget_after: z.string().optional(),
    event_date: z.string().optional(),
    contradicts_hint: z.string().optional(),
    extends_hint: z.string().optional(),
    parent_hint: z.string().optional(),
  })
  .transform((d) => ({
    text: (d.text ?? d.fact ?? "").trim(),
    is_static: d.is_static,
    abstraction_level: d.abstraction_level as 0 | 1 | 2,
    forget_after: d.forget_after,
    event_date: d.event_date,
    contradicts_hint: d.contradicts_hint,
    extends_hint: d.extends_hint,
    parent_hint: d.parent_hint,
  }))
  .refine((d) => d.text.length > 0, { message: "fact must have non-empty text" });

const reminderSchema = z.object({
  text: z.string(),
  due_at: z.string(),
});

const extractionSchema = z
  .object({
    facts: z.array(z.unknown()).default([]),
    reminders: z.array(z.unknown()).default([]),
    follow_up_reminders: z.array(z.unknown()).default([]),
  })
  .transform((data) => ({
    facts: data.facts
      .map((f): z.infer<typeof factSchema> | null => {
        // LLM sometimes returns plain strings instead of objects — normalise them
        if (typeof f === "string") {
          const text = f.trim();
          return text
            ? {
                text,
                is_static: false,
                abstraction_level: 0,
                forget_after: undefined,
                event_date: undefined,
                contradicts_hint: undefined,
                extends_hint: undefined,
                parent_hint: undefined,
              }
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
    follow_up_reminders: data.follow_up_reminders
      .map((r) => reminderSchema.safeParse(r))
      .filter((r) => r.success)
      .map((r) => (r as { success: true; data: { text: string; due_at: string } }).data),
  }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first JSON object from a string.
 * Handles: raw JSON, ```json fenced JSON, fenced JSON followed by explanation text.
 */
function extractJSON(s: string): string {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return s.slice(start, end + 1);
  return s.trim();
}

// ---------------------------------------------------------------------------
// LLM client (shared factory — includes OpenRouter headers when applicable)
// ---------------------------------------------------------------------------

import OpenAI from "openai";
let _client: OpenAI | null = null;
function llm(): OpenAI {
  if (!_client) _client = makeOpenAIClient();
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

IMPORTANT: Extract useful memory aggressively, but keep facts atomic and typed. If a message contains genuinely NEW information, extract it. Skip anything already captured in "What you already know" unless it changed or adds detail.
${existingSection}
Today's datetime: ${documentDate}

Return a JSON object — all fields required (use empty arrays if nothing applies):
{
  "facts": [...],
  "reminders": [...],
  "follow_up_reminders": [...]
}

FACTS — each fact MUST be a JSON object, not a string:
  {
    "text": "User ...",
    "abstraction_level": 0 | 1 | 2,
    "is_static": true | false,
    "event_date": "ISO date or datetime if relevant",
    "forget_after": "ISO datetime, ONLY for level 0",
    "contradicts_hint": "old fact phrase if this corrects/replaces it",
    "extends_hint": "old fact phrase if this refines/adds detail without contradiction",
    "parent_hint": "existing higher-level fact this is an instance of"
  }

ABSTRACTION LEVELS:

Level 0: specific event, state, plan, or one-off observation.
  Examples: "User is tired", "User has an exam on 2026-04-29", "User played soccer yesterday", "User submitted the YC application"
  These can expire. Current state expires quickly; dated plans/events expire shortly after event_date.

Level 1: recurring behavior, habit, pattern, or medium-term active context.
  Examples: "User plays soccer regularly", "User struggles with consistent gym attendance", "User tends to overcommit across school, startup, and fitness"
  These do not expire by time; they update or refine as new evidence accumulates.

Level 2: core identity, values, character, or durable self-model.
  Examples: "User values ambitious building projects", "User fears wasting potential", "User values physical competition"
  These do not expire by time, but they can be updated if the user explicitly changes.

If unsure between levels, choose the lower level. Consolidation will promote patterns later.

VERSIONING:
- Use contradicts_hint when the new fact makes an old fact false or replaces it.
- Use extends_hint when the new fact adds detail or makes an older fact more specific without making it false.
- Do not create a separate fact about what the user "previously said" or "used to think".

PARENTS:
- Use parent_hint when this fact is clearly an instance of an existing higher-level fact in WHAT YOU ALREADY KNOW.
- Level 0 facts can have Level 1 parents. Level 1 facts can have Level 2 parents. Never connect Level 0 directly to Level 2.

EXTRACTION RULES:
- Third person always: "User" not "I"
- ONE fact per entry — never bundle. "doing X and Y" means two separate facts
- LISTS = multiple facts. "my life has 3 parts: A, B, C" means one summary fact plus one fact per item
- Names of people: "User has a friend named Ethan"
- Projects/startups/companies: always extract, include name if given
- is_static means unlikely to change, independent of abstraction level. Past confirmed events can be static. Future plans usually are not.
- forget_after is ONLY for level 0. Current state: today + 12 hours. Dated event/plan: event_date + 24 hours. Level 1 and 2: omit forget_after.
- Lean toward extraction. A slightly redundant fact is fine. A missed fact is bad.
- DO NOT extract meta/conversational noise: "User is discussing X", "User is asking about Y", "User joked that..." — only extract facts about their actual life, opinions, plans, or identity.

REMINDERS — explicit asks AND time-bound intent:
Triggers: "remind me", "don't let me forget", "ping me", "i have to X in N minutes/hours", "i need to X in N minutes/hours", "i gotta X by [time]"
NOT triggers: open-ended intent with no time ("i should call mom", "i need to study more") — only create a reminder if there's a clear timeframe
due_at: ISO8601 datetime (use today's date + time context to compute)

FOLLOW_UP_REMINDERS — deferred plans:
Triggers: "wanna X later", "gonna X later", "planning to X", "meant to X"
Alfred creates a check-in: "hey did you ever [X]?"
due_at estimate: "later"=+4h, "tonight"=9pm today, "tomorrow"=next 9am, "this week"=+3days 9am

If truly nothing extractable: {"facts":[],"reminders":[],"todoist_tasks":[],"follow_up_reminders":[]}`;
}

function addHoursISO(base: string, hours: number): string {
  const d = new Date(base);
  if (Number.isNaN(d.getTime())) return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  d.setHours(d.getHours() + hours);
  return d.toISOString();
}

function normalizeForgetAfter(fact: z.infer<typeof factSchema>, documentDate: string): string | undefined {
  if (fact.abstraction_level !== 0) return undefined;
  if (fact.forget_after) return fact.forget_after;
  if (fact.event_date) return addHoursISO(fact.event_date, 24);
  return addHoursISO(documentDate, 12);
}

function factLine(f: { text: string; abstraction_level: number }): string {
  return `[L${f.abstraction_level}] ${f.text}`;
}

function findHintFact(hint: string, expectedLevel?: number, excludeId?: number): number | undefined {
  const candidates = searchFactsFTS(hint, 8);
  for (const c of candidates) {
    if (c.id === excludeId) continue;
    const f = getFactById(c.id);
    if (!f || !f.is_latest || f.is_forgotten) continue;
    if (expectedLevel !== undefined && f.abstraction_level !== expectedLevel) continue;
    return f.id;
  }
  return undefined;
}

const MAX_INSTANCE_PARENTS = 3;
const INSTANCE_PARENT_DISTANCE = 0.42;
const INSTANCE_CHILD_DISTANCE = 0.42;

async function wireParent(factId: number, factText: string, level: 0 | 1 | 2, parentHint?: string): Promise<void> {
  if (level >= 2) return;
  const parentLevel = level + 1;
  const parentIds: number[] = [];
  const hintedParentId = parentHint ? findHintFact(parentHint, parentLevel, factId) : undefined;
  if (hintedParentId) parentIds.push(hintedParentId);

  try {
    const hits = await querySimilarFacts(factText, 8, { abstraction_level: parentLevel });
    for (const hit of hits) {
      if (parentIds.length >= MAX_INSTANCE_PARENTS) break;
      if (hit.factId === factId || hit.distance > INSTANCE_PARENT_DISTANCE) continue;
      const f = getFactById(hit.factId);
      if (!f || !f.is_latest || f.is_forgotten || f.abstraction_level !== parentLevel) continue;
      if (parentIds.includes(f.id)) continue;
      parentIds.push(f.id);
    }
  } catch {
    // ChromaDB unavailable; parent wiring can be recovered by consolidation later.
  }

  const wired: number[] = [];
  for (const parentId of parentIds) {
    if (insertInstanceOfRelation(factId, parentId)) wired.push(parentId);
  }
  if (wired.length > 0) {
    console.log(`[extractor] instance parents: fact_${factId} -> [${wired.map(id => `fact_${id}`).join(", ")}]`);
  }
}

async function wireExistingChildren(parentId: number, parentText: string, parentLevel: 0 | 1 | 2): Promise<void> {
  if (parentLevel <= 0) return;
  const childLevel = parentLevel - 1;
  const wired: number[] = [];
  try {
    const hits = await querySimilarFacts(parentText, 12, { abstraction_level: childLevel });
    for (const hit of hits) {
      if (hit.factId === parentId || hit.distance > INSTANCE_CHILD_DISTANCE) continue;
      const child = getFactById(hit.factId);
      if (!child || !child.is_latest || child.is_forgotten || child.abstraction_level !== childLevel) continue;
      if (insertInstanceOfRelation(child.id, parentId)) wired.push(child.id);
    }
  } catch {
    // ChromaDB unavailable; children can still be wired by future extraction/consolidation.
  }
  if (wired.length > 0) {
    console.log(`[extractor] instance children: fact_${parentId} <- [${wired.map(id => `fact_${id}`).join(", ")}]`);
  }
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

  // Build "what you already know" context for the LLM:
  // profile facts (always) + topically-relevant recent facts (FTS search on session text)
  // This prevents re-extraction of facts that are already stored about the same topic.
  const profileFacts = [...getStaticProfileFacts(), ...getDynamicProfileFacts()];
  const levelFacts = [...getLevel2Facts(), ...getBedrockFacts()].map(factLine);
  const topicFacts = searchFactsFTS(opts.messageText, 20).map((h) => h.text);
  const existingFacts = [...new Set([...levelFacts, ...profileFacts, ...topicFacts])].slice(0, 50);

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
    parsed = extractionSchema.parse(JSON.parse(extractJSON(raw)));
  } catch (err) {
    console.error("[extractor] parse failed:", raw, err);
    return;
  }

  console.log(
    `[extractor] extracted: ${parsed.facts.length} facts, ${parsed.reminders.length} reminders, ` +
    `${parsed.follow_up_reminders.length} follow-ups`,
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
    // Pre-insertion similarity guard: skip if an existing fact is nearly identical.
    // Catches cases where the LLM rephrases an existing fact rather than skipping it.
    if (!fact.contradicts_hint && !fact.extends_hint) {
      try {
        const nearby = await querySimilarFacts(fact.text, 3);
        const duplicate = nearby.find((hit) => {
          const existing = getFactById(hit.factId);
          return existing && existing.is_latest && !existing.is_forgotten && hit.distance < 0.18;
        });
        if (duplicate) {
          console.log(`[extractor] skip near-duplicate (dist=${duplicate.distance.toFixed(3)}): "${fact.text.slice(0, 60)}" ≈ "${duplicate.text.slice(0, 60)}"`);
          continue;
        }
      } catch {
        // ChromaDB not ready — proceed without guard
      }
    }

    const forgetAfter = normalizeForgetAfter(fact, opts.documentDate);
    console.log(`[extractor] fact L${fact.abstraction_level}: "${fact.text}" (static=${fact.is_static})`);
    try {
      const factId = insertFact({
        text: fact.text,
        is_static: fact.is_static,
        abstraction_level: fact.abstraction_level,
        document_date: opts.documentDate,
        event_date: fact.event_date,
        forget_after: forgetAfter,
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
            markSuperseded(old.id, factId, { rewireChildren: false });
            console.log(`[extractor] updates: fact_${factId} -> fact_${old.id} "${old.text}"`);
          }
        } catch (err) {
          console.error(`[extractor] contradiction resolver failed:`, err);
        }
      }

      if (fact.extends_hint) {
        try {
          const candidates = searchFactsFTS(fact.extends_hint, 5).filter((c) => c.id !== factId);
          if (candidates.length > 0) {
            const old = candidates[0];
            insertRelation(factId, old.id, "extends");
            markSuperseded(old.id, factId, { rewireChildren: true });
            console.log(`[extractor] extends: fact_${factId} -> fact_${old.id} "${old.text}"`);
          }
        } catch (err) {
          console.error(`[extractor] extension resolver failed:`, err);
        }
      }

      try {
        const chromaId = await chromaUpsert(factId, fact.text, {
          is_static: fact.is_static,
          abstraction_level: fact.abstraction_level,
          document_date: opts.documentDate,
          ...(fact.event_date ? { event_date: fact.event_date } : {}),
          user_id: config().USER_ID,
        });
        updateChromaId(factId, chromaId);
        await wireParent(factId, fact.text, fact.abstraction_level, fact.parent_hint);
        await wireExistingChildren(factId, fact.text, fact.abstraction_level);

        // --- Knowledge graph: auto-wire relates_to edges ---
        // Query ChromaDB for semantically similar same-level existing facts.
        // Distance < 0.12: near-duplicate, skip (already handled by dedup/contradiction)
        // Distance 0.12–0.55: clearly related — create a graph edge
        // Distance > 0.55: too loosely related, skip
        try {
          const similar = await querySimilarFacts(fact.text, 10, { abstraction_level: fact.abstraction_level });
          const wired: number[] = [];
          for (const hit of similar) {
            if (hit.factId === factId || hit.factId <= 0) continue;
            if (hit.distance < 0.12 || hit.distance > 0.55) continue;
            const other = getFactById(hit.factId);
            if (!other || !other.is_latest || other.is_forgotten) continue;
            if (other.abstraction_level !== fact.abstraction_level) continue;
            insertRelation(factId, hit.factId, "relates_to");
            wired.push(hit.factId);
          }
          if (wired.length > 0) {
            console.log(`[extractor] graph edges: fact_${factId} ↔ [${wired.map(id => `fact_${id}`).join(", ")}]`);
          }
        } catch {
          // ChromaDB query failed — skip graph wiring, not critical
        }
      } catch (err) {
        console.error(`[extractor] ChromaDB upsert failed for "${fact.text}":`, err);
      }

      if (fact.abstraction_level > 0) {
        try {
          upsertProfileFact({
            fact: fact.text,
            is_static: fact.is_static,
            source_fact_id: factId,
          });
        } catch (err) {
          console.error(`[extractor] profile upsert failed for "${fact.text}":`, err);
        }
      }
    } catch (err) {
      console.error(`[extractor] insertFact failed for "${fact.text}":`, err);
    }
  }

  console.log(`[extractor] done for message ${opts.messageId}`);
}
