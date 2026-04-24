import { db } from "../db/schema.js";
import { config } from "../config.js";

export type AbstractionLevel = 0 | 1 | 2;
export type RelationType =
  | "updates"
  | "extends"
  | "derives"
  | "relates_to"
  | "instance_of"
  | "consolidated_from";

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces
// ─────────────────────────────────────────────────────────────────────────────

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
  /** 0=specific event/state, 1=behavioral pattern, 2=identity/values/character */
  abstraction_level: AbstractionLevel;
  /** Total facts in this node's subtree via instance_of edges. Higher = structurally more important. */
  descendant_count: number;
}

export interface Reminder {
  id: number;
  text: string;
  due_at: string;
}

// Shared column list used by all SELECT queries — avoids repetition and keeps
// COALESCE defaults for rows that predate the v3 migration.
const FACT_COLS = `
  id, text, is_static, is_latest, is_forgotten, document_date,
  event_date, forget_after, chroma_id, source_message_id,
  COALESCE(abstraction_level, 1) AS abstraction_level,
  COALESCE(descendant_count, 0)  AS descendant_count
`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// Fact writes
// ─────────────────────────────────────────────────────────────────────────────

export function insertFact(fact: {
  text: string;
  is_static: boolean;
  document_date: string;
  /** 0=event/state, 1=pattern, 2=identity. Defaults to 1. */
  abstraction_level?: AbstractionLevel;
  event_date?: string;
  forget_after?: string;
  source_message_id?: number;
  parent_fact_id?: number;
  root_fact_id?: number;
}): number {
  const result = db()
    .prepare(
      `INSERT INTO memory_facts
         (user_id, text, is_static, abstraction_level, document_date, event_date,
          forget_after, source_message_id, parent_fact_id, root_fact_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      config().USER_ID,
      fact.text,
      fact.is_static ? 1 : 0,
      fact.abstraction_level ?? 1,
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

/**
 * Mark oldFactId as superseded by newFactId.
 *
 * The edge type is inserted by the caller. This helper only handles the row state
 * and structural maintenance:
 * - updates: keep old children attached to old fact as historical evidence
 * - extends: rewire children to the refined fact
 * - both: inherit old parents so the new fact occupies the same abstraction path
 */
export function markSuperseded(
  oldFactId: number,
  newFactId: number,
  opts: { rewireChildren?: boolean; inheritParents?: boolean } = {},
): void {
  db().prepare("UPDATE memory_facts SET is_latest = 0 WHERE id = ?").run(oldFactId);
  db().prepare("DELETE FROM user_profile WHERE source_fact_id = ?").run(oldFactId);

  if (opts.rewireChildren) {
    rewireChildren(oldFactId, newFactId);
  }

  if (opts.inheritParents !== false) {
    const parents = getInstanceOfParents(oldFactId);
    for (const parentId of parents) {
      insertInstanceOfRelation(newFactId, parentId, { propagate: false });
    }
    if (parents.length > 0) {
      console.log(`[facts] fact_${newFactId} inherited ${parents.length} parent(s) from fact_${oldFactId}`);
    }
  }
}

export function markForgotten(factId: number): void {
  db().prepare("UPDATE memory_facts SET is_forgotten = 1 WHERE id = ?").run(factId);
  db().prepare("DELETE FROM user_profile WHERE source_fact_id = ?").run(factId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph edges
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Insert a relation edge between two facts.
 *
 * Directionality semantics:
 *   relates_to        — undirected. Canonical min/max ordering prevents (A,B)/(B,A) duplicates.
 *   instance_of       — directed: source (specific) → target (abstract, one level up)
 *   updates           — directed: source (new/correct) → target (superseded)
 *   extends           — directed: source (refined) → target (original, still valid)
 *   derives           — directed: source (inferred) → target (source fact, stays active)
 *   consolidated_from — directed: source (summary) → target (archived instance)
 */
export function insertRelation(
  sourceId: number,
  targetId: number,
  relationType: RelationType,
): boolean {
  // Only relates_to is undirected — canonicalize to prevent duplicate undirected edges.
  // All directed types use natural order: source in fact_id_a, target in fact_id_b.
  const [a, b] =
    relationType === "relates_to"
      ? sourceId < targetId
        ? [sourceId, targetId]
        : [targetId, sourceId]
      : [sourceId, targetId];
  const result = db()
    .prepare(
      "INSERT OR IGNORE INTO fact_relations (fact_id_a, fact_id_b, relation_type) VALUES (?, ?, ?)",
    )
    .run(a, b, relationType);
  return result.changes > 0;
}

export function insertInstanceOfRelation(
  childId: number,
  parentId: number,
  opts: { propagate?: boolean } = {},
): boolean {
  const child = getFactById(childId);
  const parent = getFactById(parentId);
  if (!child || !parent) return false;
  if (parent.abstraction_level !== child.abstraction_level + 1) {
    console.log(
      `[facts] skip invalid instance_of: fact_${childId}(L${child.abstraction_level}) -> ` +
      `fact_${parentId}(L${parent.abstraction_level})`,
    );
    return false;
  }
  const inserted = insertRelation(childId, parentId, "instance_of");
  if (inserted && opts.propagate !== false) {
    // delta = 1 (the child itself) + child's existing subtree size
    const child = getFactById(childId);
    const delta = 1 + (child?.descendant_count ?? 0);
    propagateDescendantIncrement(parentId, delta);
  }
  return inserted;
}

/** Return IDs of all facts connected to factId via relates_to (both directions, undirected). */
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
 * Return IDs of all facts that have an instance_of edge pointing TO parentFactId.
 * These are the direct children of parentFactId in the abstraction hierarchy.
 */
export function getInstanceOfChildren(parentFactId: number): number[] {
  const rows = db()
    .prepare(
      "SELECT fact_id_a FROM fact_relations WHERE fact_id_b = ? AND relation_type = 'instance_of'",
    )
    .all(parentFactId) as { fact_id_a: number }[];
  return rows.map((r) => r.fact_id_a);
}

/**
 * Return IDs of all facts that factId has an instance_of edge TO.
 * These are the direct parents of factId (one level up in the hierarchy).
 */
export function getInstanceOfParents(factId: number): number[] {
  const rows = db()
    .prepare(
      "SELECT fact_id_b FROM fact_relations WHERE fact_id_a = ? AND relation_type = 'instance_of'",
    )
    .all(factId) as { fact_id_b: number }[];
  return rows.map((r) => r.fact_id_b);
}

/**
 * When oldParentId is superseded by newParentId, re-point its instance_of children.
 * Old edges are preserved as version history. Transfers descendant_count so the
 * new parent node starts with the same structural importance as the old one.
 */
export function rewireChildren(oldParentId: number, newParentId: number): void {
  const children = getInstanceOfChildren(oldParentId);
  if (children.length === 0) return;
  for (const childId of children) {
    insertInstanceOfRelation(childId, newParentId);
  }
  // Transfer descendant_count: new parent inherits the same subtree size.
  const oldFact = getFactById(oldParentId);
  if (oldFact && oldFact.descendant_count > 0) {
    db()
      .prepare("UPDATE memory_facts SET descendant_count = ? WHERE id = ?")
      .run(oldFact.descendant_count, newParentId);
  }
  console.log(`[facts] rewired ${children.length} child(ren): fact_${oldParentId} → fact_${newParentId}`);
}

/**
 * Called after wiring a new child to parentId (via instance_of edge). Increments
 * descendant_count on parentId and all ancestors by `delta`.
 *
 * delta should be 1 + child.descendant_count so the parent's count reflects the
 * full subtree size being added, not just the immediate child.
 * Multi-parent and cycle safe.
 */
export function propagateDescendantIncrement(parentId: number, delta = 1): void {
  const stack = [parentId];
  const visited = new Set<number>();
  while (stack.length > 0) {
    const currentId = stack.pop();
    if (currentId === undefined || visited.has(currentId)) continue;
    visited.add(currentId);
    db()
      .prepare("UPDATE memory_facts SET descendant_count = descendant_count + ? WHERE id = ?")
      .run(delta, currentId);
    stack.push(...getInstanceOfParents(currentId));
  }
}

export function recalculateDescendantCount(factId: number): number {
  const visited = new Set<number>();
  const walk = (id: number): number => {
    let total = 0;
    for (const childId of getInstanceOfChildren(id)) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      total += 1 + walk(childId);
    }
    return total;
  };
  const count = walk(factId);
  db().prepare("UPDATE memory_facts SET descendant_count = ? WHERE id = ?").run(count, factId);
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fact reads
// ─────────────────────────────────────────────────────────────────────────────

export function getFactById(id: number): MemoryFact | undefined {
  return db()
    .prepare(`SELECT ${FACT_COLS} FROM memory_facts WHERE id = ?`)
    .get(id) as MemoryFact | undefined;
}

/**
 * Level 2 identity/values facts. Always injected into every context window regardless
 * of the query — these define who the person is and affect every response.
 */
export function getLevel2Facts(): MemoryFact[] {
  return db()
    .prepare(
      `SELECT ${FACT_COLS}
       FROM memory_facts
       WHERE user_id = ? AND COALESCE(abstraction_level, 1) = 2
         AND is_latest = 1 AND is_forgotten = 0
       ORDER BY COALESCE(descendant_count, 0) DESC`,
    )
    .all(config().USER_ID) as MemoryFact[];
}

/**
 * Top Level 1 behavioral patterns, ranked by structural importance (descendant_count).
 * Facts that root large subtrees surface here even when not recently mentioned —
 * this corrects for the "conversation frequency ≠ life importance" problem.
 *
 * Scoring: descendant_count / (1 + age_days × 0.05)
 * Cold-start fallback (all descendant_counts = 0): oldest Level 1 patterns.
 */
export function getBedrockFacts(): MemoryFact[] {
  return db()
    .prepare(
      `SELECT ${FACT_COLS}
       FROM memory_facts
       WHERE user_id = ? AND COALESCE(abstraction_level, 1) = 1
         AND is_latest = 1 AND is_forgotten = 0
       ORDER BY
         CAST(COALESCE(descendant_count, 0) AS REAL)
           / (1.0 + (julianday('now') - julianday(created_at)) * 0.05) DESC,
         created_at ASC
       LIMIT 5`,
    )
    .all(config().USER_ID) as MemoryFact[];
}

export function getActiveStaticFacts(): MemoryFact[] {
  return db()
    .prepare(
      `SELECT ${FACT_COLS}
       FROM memory_facts
       WHERE user_id = ? AND is_static = 1 AND is_latest = 1 AND is_forgotten = 0
       ORDER BY created_at DESC LIMIT 20`,
    )
    .all(config().USER_ID) as MemoryFact[];
}

export function getActiveDynamicFacts(): MemoryFact[] {
  return db()
    .prepare(
      `SELECT ${FACT_COLS}
       FROM memory_facts
       WHERE user_id = ? AND is_static = 0 AND is_latest = 1 AND is_forgotten = 0
        AND (forget_after IS NULL OR datetime(forget_after) > datetime('now'))
       ORDER BY
         CASE WHEN event_date IS NOT NULL AND event_date > datetime('now') THEN 0 ELSE 1 END ASC,
         event_date ASC,
         created_at DESC
       LIMIT 30`,
    )
    .all(config().USER_ID) as MemoryFact[];
}

export function getFactsByLevel(level: AbstractionLevel, limit = 50): MemoryFact[] {
  return db()
    .prepare(
      `SELECT ${FACT_COLS}
       FROM memory_facts
       WHERE user_id = ? AND COALESCE(abstraction_level, 1) = ?
         AND is_latest = 1 AND is_forgotten = 0
       ORDER BY COALESCE(descendant_count, 0) DESC, created_at DESC
       LIMIT ?`,
    )
    .all(config().USER_ID, level, limit) as MemoryFact[];
}

export function getExpiredLevel0Facts(limit = 50): MemoryFact[] {
  return db()
    .prepare(
      `SELECT ${FACT_COLS}
       FROM memory_facts
       WHERE user_id = ? AND COALESCE(abstraction_level, 1) = 0
         AND is_latest = 1 AND is_forgotten = 0
         AND forget_after IS NOT NULL
         AND datetime(forget_after) < datetime('now')
       ORDER BY forget_after ASC
       LIMIT ?`,
    )
    .all(config().USER_ID, limit) as MemoryFact[];
}

export function getUpcomingEventFacts(withinDays: number): MemoryFact[] {
  return db()
    .prepare(
      `SELECT ${FACT_COLS}
       FROM memory_facts
       WHERE user_id = ? AND is_latest = 1 AND is_forgotten = 0
         AND event_date IS NOT NULL
         AND event_date >= date('now')
         AND event_date <= date('now', '+' || ? || ' days')
       ORDER BY event_date ASC`,
    )
    .all(config().USER_ID, withinDays) as MemoryFact[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Reminders
// ─────────────────────────────────────────────────────────────────────────────

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

/** Strict variant — only reminders that are actually past due (±2 min buffer).
 *  Used by the per-minute cron so reminders don't fire early. */
export function getStrictlyDueReminders(): Reminder[] {
  return db()
    .prepare(
      `SELECT id, text, due_at FROM reminders
       WHERE user_id = ? AND fired_at IS NULL
         AND due_at <= datetime('now', '+2 minutes')
       ORDER BY due_at ASC`,
    )
    .all(config().USER_ID) as Reminder[];
}

export function markReminderFired(id: number): void {
  db()
    .prepare("UPDATE reminders SET fired_at = datetime('now') WHERE id = ?")
    .run(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// User profile (materialized key/value view — fast lookup for extraction dedup)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// FTS (BM25 keyword search)
// ─────────────────────────────────────────────────────────────────────────────

export interface FTSHit {
  id: number;
  text: string;
  rank: number;
}

/** BM25 full-text keyword search over memory_facts. Falls back to [] on FTS errors. */
export function searchFactsFTS(query: string, limit = 10): FTSHit[] {
  try {
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
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Proactive log
// ─────────────────────────────────────────────────────────────────────────────

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
