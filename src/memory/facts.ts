import { db } from "../db/schema.js";
import { config } from "../config.js";

export interface MemoryFact {
  id: number;
  text: string;
  is_static: boolean;
  document_date: string;
  event_date?: string;
  forget_after?: string;
  chroma_id?: string;
}

export interface Reminder {
  id: number;
  text: string;
  due_at: string;
}

export function insertFact(fact: {
  text: string;
  is_static: boolean;
  document_date: string;
  event_date?: string;
  forget_after?: string;
  source_message_id?: number;
  parent_fact_id?: number;
  root_fact_id?: number;
}): number {
  const stmt = db().prepare(`
    INSERT INTO memory_facts (user_id, text, is_static, document_date, event_date,
      forget_after, source_message_id, parent_fact_id, root_fact_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    config().USER_ID,
    fact.text,
    fact.is_static ? 1 : 0,
    fact.document_date,
    fact.event_date ?? null,
    fact.forget_after ?? null,
    fact.source_message_id ?? null,
    fact.parent_fact_id ?? null,
    fact.root_fact_id ?? null,
  );
  return result.lastInsertRowid as number;
}

export function updateChromaId(factId: number, chromaId: string): void {
  db().prepare("UPDATE memory_facts SET chroma_id = ? WHERE id = ?").run(chromaId, factId);
}

export function markSuperseded(factId: number): void {
  db().prepare("UPDATE memory_facts SET is_latest = 0 WHERE id = ?").run(factId);
}

export function insertRelation(
  factIdA: number,
  factIdB: number,
  relationType: "updates" | "extends" | "derives",
): void {
  db()
    .prepare(
      "INSERT INTO fact_relations (fact_id_a, fact_id_b, relation_type) VALUES (?, ?, ?)",
    )
    .run(factIdA, factIdB, relationType);
}

export function insertReminder(reminder: {
  text: string;
  due_at: string;
  source_message_id?: number;
}): void {
  db()
    .prepare(
      "INSERT INTO reminders (user_id, text, due_at, source_message_id) VALUES (?, ?, ?, ?)",
    )
    .run(config().USER_ID, reminder.text, reminder.due_at, reminder.source_message_id ?? null);
}

export function getDueReminders(): Reminder[] {
  return db()
    .prepare(
      `SELECT id, text, due_at FROM reminders
       WHERE user_id = ? AND fired_at IS NULL
         AND due_at <= datetime('now', '+1 hour')
       ORDER BY due_at ASC`,
    )
    .all(config().USER_ID) as Reminder[];
}

export function markReminderFired(id: number): void {
  db()
    .prepare("UPDATE reminders SET fired_at = datetime('now') WHERE id = ?")
    .run(id);
}

export function getActiveStaticFacts(): MemoryFact[] {
  return db()
    .prepare(
      `SELECT id, text, is_static, document_date, event_date, forget_after, chroma_id
       FROM memory_facts
       WHERE user_id = ? AND is_static = 1 AND is_latest = 1 AND is_forgotten = 0
       ORDER BY created_at DESC LIMIT 20`,
    )
    .all(config().USER_ID) as MemoryFact[];
}

export function getActiveDynamicFacts(): MemoryFact[] {
  return db()
    .prepare(
      `SELECT id, text, is_static, document_date, event_date, forget_after, chroma_id
       FROM memory_facts
       WHERE user_id = ? AND is_static = 0 AND is_latest = 1 AND is_forgotten = 0
         AND (forget_after IS NULL OR forget_after > datetime('now'))
       ORDER BY created_at DESC LIMIT 30`,
    )
    .all(config().USER_ID) as MemoryFact[];
}

export function getFactById(id: number): MemoryFact | undefined {
  return db()
    .prepare(
      `SELECT id, text, is_static, document_date, event_date, forget_after, chroma_id
       FROM memory_facts WHERE id = ?`,
    )
    .get(id) as MemoryFact | undefined;
}

export function upsertProfileFact(fact: {
  fact: string;
  is_static: boolean;
  source_fact_id?: number;
}): void {
  db()
    .prepare(
      `INSERT INTO user_profile (user_id, fact, is_static, source_fact_id, last_updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, fact) DO UPDATE SET
         is_static = excluded.is_static,
         last_updated_at = datetime('now')`,
    )
    .run(config().USER_ID, fact.fact, fact.is_static ? 1 : 0, fact.source_fact_id ?? null);
}

export function getStaticProfileFacts(): string[] {
  return (
    db()
      .prepare(
        `SELECT fact FROM user_profile WHERE user_id = ? AND is_static = 1
         ORDER BY last_updated_at DESC LIMIT 15`,
      )
      .all(config().USER_ID) as Array<{ fact: string }>
  ).map((r) => r.fact);
}

export function getDynamicProfileFacts(): string[] {
  return (
    db()
      .prepare(
        `SELECT fact FROM user_profile WHERE user_id = ? AND is_static = 0
         ORDER BY last_updated_at DESC LIMIT 10`,
      )
      .all(config().USER_ID) as Array<{ fact: string }>
  ).map((r) => r.fact);
}

export function logProactive(triggerType: string, content: string): void {
  db()
    .prepare(
      "INSERT INTO proactive_log (user_id, trigger_type, content_sent) VALUES (?, ?, ?)",
    )
    .run(config().USER_ID, triggerType, content);
}

export function getLastProactiveSentAt(): Date | null {
  const row = db()
    .prepare(
      "SELECT sent_at FROM proactive_log WHERE user_id = ? ORDER BY sent_at DESC LIMIT 1",
    )
    .get(config().USER_ID) as { sent_at: string } | undefined;
  return row ? new Date(row.sent_at) : null;
}

export function insertMessage(msg: {
  imessage_row_id?: number;
  raw_text?: string;
  media_type: string;
  transcript?: string;
  file_summary?: string;
}): number {
  const result = db()
    .prepare(
      `INSERT OR IGNORE INTO messages
         (user_id, imessage_row_id, raw_text, media_type, transcript, file_summary, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      config().USER_ID,
      msg.imessage_row_id ?? null,
      msg.raw_text ?? null,
      msg.media_type,
      msg.transcript ?? null,
      msg.file_summary ?? null,
    );
  return result.lastInsertRowid as number;
}

export function getRecentMessages(
  n = 20,
): Array<{ content: string; created_at: string }> {
  const rows = db()
    .prepare(
      `SELECT raw_text, transcript, file_summary, created_at
       FROM messages WHERE user_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(config().USER_ID, n)
    .reverse() as Array<{
    raw_text: string | null;
    transcript: string | null;
    file_summary: string | null;
    created_at: string;
  }>;

  return rows.map((r) => ({
    content: r.transcript ?? r.file_summary ?? r.raw_text ?? "",
    created_at: r.created_at,
  }));
}
