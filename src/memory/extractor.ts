import OpenAI from "openai";
import { z } from "zod";
import { config } from "../config.js";
import {
  insertFact,
  insertReminder,
  updateChromaId,
  upsertProfileFact,
} from "./facts.js";
import { upsertFact as chromaUpsert } from "./vectors.js";
import { createTask } from "../integrations/todoist.js";

const factSchema = z.object({
  text: z.string(),
  is_static: z.boolean(),
  forget_after: z.string().optional(),
  event_date: z.string().optional(),
  contradicts_hint: z.string().optional(),
});

const reminderSchema = z.object({
  text: z.string(),
  due_at: z.string(),
});

const todoistTaskSchema = z.object({
  content: z.string(),
  due_string: z.string().optional(),
});

const extractionSchema = z.object({
  facts: z.array(factSchema).default([]),
  reminders: z.array(z.unknown()).default([]),
  todoist_tasks: z.array(z.unknown()).default([]),
}).transform((data) => ({
  facts: data.facts,
  reminders: data.reminders
    .map((r) => reminderSchema.safeParse(r))
    .filter((r) => r.success)
    .map((r) => (r as { success: true; data: { text: string; due_at: string } }).data),
  todoist_tasks: data.todoist_tasks
    .map((t) => todoistTaskSchema.safeParse(t))
    .filter((t) => t.success)
    .map((t) => (t as { success: true; data: { content: string; due_string?: string } }).data),
}));

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

const SYSTEM = `You extract memory facts from a personal journal message. The user is speaking about their own life.

You MUST return a JSON object with this exact structure:
{
  "facts": [...],
  "reminders": [...]
}

Both fields are required arrays (can be empty). Never return anything else.

Rules for facts:
- Rewrite each fact in third person: "User" not "I"
- One discrete fact per entry — do not bundle multiple facts
- is_static: true for stable long-term facts ("User is a designer"), false for temporary state
- forget_after: ISO8601 date for facts that will become irrelevant (optional)
- event_date: ISO8601 date when the described event occurs, if different from now (optional)
- contradicts_hint: a short phrase matching an existing fact this supersedes (optional)

Rules for reminders:
- Only extract when user explicitly says "remind me", "don't let me forget", etc.
- due_at: ISO8601 datetime

Rules for todoist_tasks:
- Only extract when the user expresses a clear intention to do something ("i need to", "i have to", "gotta", "should probably")
- content: short actionable task title
- due_string: natural language due date if mentioned (e.g. "tomorrow", "next Monday") — optional

If the message has no extractable content, return: {"facts": [], "reminders": [], "todoist_tasks": []}`;

export async function extractFromMessage(opts: {
  messageText: string;
  messageId: number;
  documentDate: string;
}): Promise<void> {
  const cfg = config();
  let raw: string;
  try {
    const response = await llm().chat.completions.create({
      model: cfg.EXTRACTION_MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: opts.messageText },
      ],
      max_tokens: 800,
      response_format: { type: "json_object" },
    });
    raw = response.choices[0]?.message?.content ?? "{}";
  } catch (err) {
    console.error("[extractor] LLM call failed:", err);
    return;
  }

  let parsed: z.infer<typeof extractionSchema>;
  try {
    parsed = extractionSchema.parse(JSON.parse(raw));
  } catch (err) {
    console.error("[extractor] Parse failed:", raw, err);
    return;
  }

  for (const reminder of parsed.reminders) {
    insertReminder({
      text: reminder.text,
      due_at: reminder.due_at,
      source_message_id: opts.messageId,
    });
  }

  for (const fact of parsed.facts) {
    const factId = insertFact({
      text: fact.text,
      is_static: fact.is_static,
      document_date: opts.documentDate,
      event_date: fact.event_date,
      forget_after: fact.forget_after,
      source_message_id: opts.messageId,
    });

    try {
      const chromaId = await chromaUpsert(factId, fact.text, {
        is_static: fact.is_static,
        document_date: opts.documentDate,
        ...(fact.event_date ? { event_date: fact.event_date } : {}),
        user_id: config().USER_ID,
      });
      updateChromaId(factId, chromaId);
    } catch (err) {
      console.error("[extractor] ChromaDB upsert failed:", err);
    }

    upsertProfileFact({
      fact: fact.text,
      is_static: fact.is_static,
      source_fact_id: factId,
    });
  }

  // Create Todoist tasks for clearly actionable items
  for (const task of parsed.todoist_tasks) {
    const created = await createTask({
      content: task.content,
      due_string: task.due_string,
    });
    if (created) {
      console.log(`[todoist] created task: "${task.content}"`);
    }
  }
}
