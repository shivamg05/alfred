import { db } from "../db/schema.js";
import { config } from "../config.js";

export interface MemoryFact {
  id: number;
  text: string;
  is_static: boolean;
  is_latest: boolean;
  is_forgotten: boolean;
  document_date: string;
  event_date?: string;
  forget_after?: string;
  chroma_id?: string;
  source_message_id?: number;
  edge_count?: number;
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
  // Also remove from user_profile so superseded facts stop appearing in context
  db().prepare("DELETE FROM user_profile WHERE source_fact_id = ?").run(factId);
}

export function insertRelation(
  factIdA: number,
  factIdB: number,
  relationType: "updates" | "extends" | "derives" | "relates_to",
): void {
  // Canonical ordering: always store lower ID as fact_id_a so (A,B) and (B,A)
  // collapse to the same row and the UNIQUE constraint prevents duplicates.
  const [a, b] = factIdA < factIdB ? [factIdA, factIdB] : [factIdB, factIdA];
  db()
    .prepare(
      "INSERT OR IGNORE INTO fact_relations (fact_id_a, fact_id_b, relation_type) VALUES (?, ?, ?)",
    )
    .run(a, b, relationType);
}

/**
 * Return the IDs of facts connected to this one via 'relates_to' edges.
 * Checks both directions since edges are stored directionally.
 */
export function getRelatedFactIds(factId: number): number[] {
  const rows = db()
    .prepare(
      `SELECT CASE WHEN fact_id_a = ? THEN fact_id_b ELSE fact_id_a END AS related_id
       FROM fact_relations
       WHERE (fact_id_a = ? OR fact_id_b = ?) AND relation_type = 'relates_to'
       LIMIT 20`,
    )
    .all(factId, factId, factId) as { related_id: number }[];
  return rows.map((r) => r.related_id);
}

/**
 * The bedrock: 5 oldest static facts. These are the first things the user
 * told Alfred about themselves and tend to be the most foundational identity
 * facts (name, school, job, location). Always injected regardless of query.
 */
/**
 * The bedrock: 5 static facts with the most graph connections.
 * High-degree nodes are the most central facts in the knowledge graph —
 * they're referenced by many other facts, making them definitionally core.
 * Falls back to oldest static facts if no edges exist yet (cold start).
 */
/**
 * The bedrock: 5 most structurally central facts regardless of static/dynamic.
 * Ranks by edge_count but applies a recency penalty so transient clusters
 * (e.g. a single soccer-game conversation that produced many edges today) don't
 * dominate over facts that have accumulated connections over weeks.
 *
 * Score = edge_count / (1 + age_days * 0.05)
 * A fact with 4 edges from today scores the same as a fact with 4 edges from
 * 20 days ago — but a fact with 4 edges from 6 months ago scores ~half.
 */
export function getBedrockFacts(): MemoryFact[] {
  return db()
    .prepare(
      `SELECT mf.id, mf.text, mf.is_static, mf.is_latest, mf.is_forgotten,
              mf.document_date, mf.event_date, mf.forget_after, mf.chroma_id, mf.source_message_id,
              COUNT(fr.id) AS edge_count,
              CAST(julianday('now') - julianday(mf.created_at) AS REAL) AS age_days
       FROM memory_facts mf
       LEFT JOIN fact_relations fr
         ON (fr.fact_id_a = mf.id OR fr.fact_id_b = mf.id)
       WHERE mf.user_id = ? AND mf.is_latest = 1 AND mf.is_forgotten = 0
       GROUP BY mf.id
       ORDER BY
         CAST(COUNT(fr.id) AS REAL) / (1.0 + (julianday('now') - julianday(mf.created_at)) * 0.05) DESC,
         mf.is_static DESC,
         mf.created_at ASC
       LIMIT 5`,
    )
    .all(config().USER_ID) as MemoryFact[];
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
       ORDER BY
         CASE WHEN event_date IS NOT NULL AND event_date > datetime('now') THEN 0 ELSE 1 END ASC,
         event_date ASC,
         created_at DESC
       LIMIT 30`,
    )
    .all(config().USER_ID) as MemoryFact[];
}

export function getFactById(id: number): MemoryFact | undefined {
  return db()
    .prepare(
      `SELECT id, text, is_static, is_latest, is_forgotten, document_date, event_date, forget_after, chroma_id, source_message_id
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

export function getMessageById(
  id: number,
): { raw_text: string | null; transcript: string | null } | undefined {
  return db()
    .prepare("SELECT raw_text, transcript FROM messages WHERE id = ?")
    .get(id) as { raw_text: string | null; transcript: string | null } | undefined;
}

export interface FTSHit {
  id: number;
  text: string;
  rank: number;
}

/** BM25 full-text keyword search over memory_facts. */
export function searchFactsFTS(query: string, limit = 10): FTSHit[] {
  try {
    // Sanitize query — FTS5 MATCH is picky about special chars
    const safe = query.replace(/['"*\-]/g, " ").trim();
    if (!safe) return [];
    return db()
      .prepare(
        `SELECT mf.id, mf.text, fts.rank
         FROM memory_facts_fts fts
         JOIN memory_facts mf ON mf.id = fts.rowid
         WHERE memory_facts_fts MATCH ?
           AND mf.user_id = ?
           AND mf.is_latest = 1
           AND mf.is_forgotten = 0
         ORDER BY fts.rank
         LIMIT ?`,
      )
      .all(safe, config().USER_ID, limit) as FTSHit[];
  } catch {
    return []; // FTS can fail on edge-case queries; don't crash retrieval
  }
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
