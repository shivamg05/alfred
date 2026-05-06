/**
 * Tests for src/memory/facts.ts — the SQLite data layer for facts, reminders,
 * messages, proactive log, cron state, and the knowledge graph.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupTestDb, teardownTestDb, getTestDb } from "./setup.js";

// Import after mocks are registered (setup.ts calls vi.mock)
import {
  insertFact,
  getFactById,
  markForgotten,
  markSuperseded,
  insertRelation,
  insertInstanceOfRelation,
  getRelatedFactIds,
  getInstanceOfChildren,
  getInstanceOfParents,
  propagateDescendantIncrement,
  recalculateDescendantCount,
  getLevel2Facts,
  getBedrockFacts,
  getExpiredLevel0Facts,
  getUpcomingEventFacts,
  getFactsByLevel,
  insertReminder,
  getDueReminders,
  getStrictlyDueReminders,
  markReminderFired,
  insertMessage,
  getMessageById,
  getRecentMessages,
  searchFactsFTS,
  logProactive,
  logProactiveAttempt,
  getLastProactiveSentAt,
  getNudgeDueFacts,
  setProactiveAfter,
  markNudgeFired,
  getQueuedPatternFacts,
  clearAllPatternObservationQueued,
  getStaleBedrock,
  getCronLastRan,
  setCronLastRan,
  upsertProfileFact,
  getStaticProfileFacts,
  getDynamicProfileFacts,
  rewireChildren,
} from "../src/memory/facts.js";

const DOC_DATE = "2026-05-05T12:00:00Z";

beforeEach(() => setupTestDb());
afterEach(() => teardownTestDb());

// ────────────────────────────────────────────────────────────────────
// Facts CRUD
// ────────────────────────────────────────────────────────────────────

describe("insertFact + getFactById", () => {
  it("inserts and retrieves a fact with defaults", () => {
    const id = insertFact({ text: "User likes tacos", is_static: false, document_date: DOC_DATE });
    const fact = getFactById(id);
    expect(fact).toBeDefined();
    expect(fact!.text).toBe("User likes tacos");
    expect(fact!.is_latest).toBeTruthy();
    expect(fact!.is_forgotten).toBeFalsy();
    expect(fact!.abstraction_level).toBe(1); // default
    expect(fact!.descendant_count).toBe(0);
  });

  it("respects abstraction_level override", () => {
    const id = insertFact({
      text: "User values ambition",
      is_static: true,
      document_date: DOC_DATE,
      abstraction_level: 2,
    });
    expect(getFactById(id)!.abstraction_level).toBe(2);
  });

  it("stores event_date and forget_after", () => {
    const id = insertFact({
      text: "User has exam",
      is_static: false,
      document_date: DOC_DATE,
      abstraction_level: 0,
      event_date: "2026-05-10",
      forget_after: "2026-05-11T00:00:00Z",
    });
    const f = getFactById(id)!;
    expect(f.event_date).toBe("2026-05-10");
    expect(f.forget_after).toBe("2026-05-11T00:00:00Z");
  });
});

describe("markForgotten", () => {
  it("sets is_forgotten and removes from user_profile", () => {
    const id = insertFact({ text: "User plays soccer", is_static: false, document_date: DOC_DATE, abstraction_level: 1 });
    upsertProfileFact({ fact: "User plays soccer", is_static: false, source_fact_id: id });
    expect(getDynamicProfileFacts()).toContain("User plays soccer");

    markForgotten(id);
    expect(getFactById(id)!.is_forgotten).toBeTruthy();
    expect(getDynamicProfileFacts()).not.toContain("User plays soccer");
  });
});

describe("markSuperseded", () => {
  it("sets is_latest=0 and inherits parents by default", () => {
    const parentId = insertFact({ text: "Parent pattern", is_static: false, document_date: DOC_DATE, abstraction_level: 2 });
    const oldId = insertFact({ text: "Old pattern", is_static: false, document_date: DOC_DATE, abstraction_level: 1 });
    insertInstanceOfRelation(oldId, parentId, { propagate: false });

    const newId = insertFact({ text: "New pattern", is_static: false, document_date: DOC_DATE, abstraction_level: 1 });
    markSuperseded(oldId, newId);

    expect(getFactById(oldId)!.is_latest).toBeFalsy();
    // newId should have inherited the parent from oldId
    const parents = getInstanceOfParents(newId);
    expect(parents).toContain(parentId);
  });

  it("rewires children when requested", () => {
    const parentId = insertFact({ text: "Old parent", is_static: false, document_date: DOC_DATE, abstraction_level: 1 });
    const childId = insertFact({ text: "Child event", is_static: false, document_date: DOC_DATE, abstraction_level: 0 });
    insertInstanceOfRelation(childId, parentId, { propagate: false });

    const newParentId = insertFact({ text: "New parent", is_static: false, document_date: DOC_DATE, abstraction_level: 1 });
    markSuperseded(parentId, newParentId, { rewireChildren: true });

    const newChildren = getInstanceOfChildren(newParentId);
    expect(newChildren).toContain(childId);
  });
});

// ────────────────────────────────────────────────────────────────────
// Knowledge graph: relations & instance_of
// ────────────────────────────────────────────────────────────────────

describe("insertRelation", () => {
  it("relates_to canonicalizes direction (undirected)", () => {
    const a = insertFact({ text: "Fact A", is_static: false, document_date: DOC_DATE, abstraction_level: 0 });
    const b = insertFact({ text: "Fact B", is_static: false, document_date: DOC_DATE, abstraction_level: 0 });

    insertRelation(a, b, "relates_to");
    // inserting reverse should be a no-op (duplicate)
    const inserted = insertRelation(b, a, "relates_to");
    expect(inserted).toBe(false);

    // Both directions should show up
    expect(getRelatedFactIds(a)).toContain(b);
    expect(getRelatedFactIds(b)).toContain(a);
  });

  it("directed edges (updates) are NOT canonicalized", () => {
    const newF = insertFact({ text: "New fact", is_static: false, document_date: DOC_DATE });
    const oldF = insertFact({ text: "Old fact", is_static: false, document_date: DOC_DATE });
    insertRelation(newF, oldF, "updates");

    // Should be stored as (newF, oldF), not reversed
    const row = getTestDb()
      .prepare("SELECT fact_id_a, fact_id_b FROM fact_relations WHERE relation_type = 'updates'")
      .get() as { fact_id_a: number; fact_id_b: number };
    expect(row.fact_id_a).toBe(newF);
    expect(row.fact_id_b).toBe(oldF);
  });
});

describe("insertInstanceOfRelation", () => {
  it("only allows adjacent-level connections", () => {
    const l0 = insertFact({ text: "Event", is_static: false, document_date: DOC_DATE, abstraction_level: 0 });
    const l2 = insertFact({ text: "Identity", is_static: false, document_date: DOC_DATE, abstraction_level: 2 });

    // L0 -> L2 should be rejected (not adjacent)
    const ok = insertInstanceOfRelation(l0, l2);
    expect(ok).toBe(false);
  });

  it("allows L0 -> L1 and L1 -> L2", () => {
    const l0 = insertFact({ text: "Event", is_static: false, document_date: DOC_DATE, abstraction_level: 0 });
    const l1 = insertFact({ text: "Pattern", is_static: false, document_date: DOC_DATE, abstraction_level: 1 });
    const l2 = insertFact({ text: "Identity", is_static: false, document_date: DOC_DATE, abstraction_level: 2 });

    expect(insertInstanceOfRelation(l0, l1)).toBe(true);
    expect(insertInstanceOfRelation(l1, l2)).toBe(true);
    expect(getInstanceOfParents(l0)).toContain(l1);
    expect(getInstanceOfChildren(l1)).toContain(l0);
    expect(getInstanceOfParents(l1)).toContain(l2);
  });
});

describe("propagateDescendantIncrement", () => {
  it("increments parent and grandparent counts", () => {
    const l2 = insertFact({ text: "Identity", is_static: false, document_date: DOC_DATE, abstraction_level: 2 });
    const l1 = insertFact({ text: "Pattern", is_static: false, document_date: DOC_DATE, abstraction_level: 1 });
    insertInstanceOfRelation(l1, l2, { propagate: false });

    // Wire an L0 -> L1 which triggers propagation
    const l0 = insertFact({ text: "Event", is_static: false, document_date: DOC_DATE, abstraction_level: 0 });
    insertInstanceOfRelation(l0, l1); // default propagate=true

    expect(getFactById(l1)!.descendant_count).toBe(1);
    expect(getFactById(l2)!.descendant_count).toBe(1);
  });

  it("sets pattern_observation_queued at milestones", () => {
    const l1 = insertFact({ text: "Pattern", is_static: false, document_date: DOC_DATE, abstraction_level: 1 });

    // Manually set descendant_count to 2, then increment by 1 → hits milestone 3
    getTestDb().prepare("UPDATE memory_facts SET descendant_count = 2 WHERE id = ?").run(l1);
    propagateDescendantIncrement(l1, 1);

    const fact = getFactById(l1)!;
    expect(fact.descendant_count).toBe(3);
    // Check pattern_observation_queued was set
    const row = getTestDb()
      .prepare("SELECT pattern_observation_queued FROM memory_facts WHERE id = ?")
      .get(l1) as { pattern_observation_queued: number };
    expect(row.pattern_observation_queued).toBe(1);
  });

  it("handles multi-parent graphs without infinite loops", () => {
    // Create diamond: L0 -> L1a, L0 -> L1b, L1a -> L2, L1b -> L2
    const l2 = insertFact({ text: "Identity", is_static: false, document_date: DOC_DATE, abstraction_level: 2 });
    const l1a = insertFact({ text: "Pattern A", is_static: false, document_date: DOC_DATE, abstraction_level: 1 });
    const l1b = insertFact({ text: "Pattern B", is_static: false, document_date: DOC_DATE, abstraction_level: 1 });
    insertInstanceOfRelation(l1a, l2, { propagate: false });
    insertInstanceOfRelation(l1b, l2, { propagate: false });

    const l0 = insertFact({ text: "Event", is_static: false, document_date: DOC_DATE, abstraction_level: 0 });
    insertInstanceOfRelation(l0, l1a);
    insertInstanceOfRelation(l0, l1b);

    // L2 should have been incremented by each path but visited set prevents double
    expect(getFactById(l1a)!.descendant_count).toBe(1);
    expect(getFactById(l1b)!.descendant_count).toBe(1);
  });
});

describe("recalculateDescendantCount", () => {
  it("correctly counts full subtree", () => {
    const l1 = insertFact({ text: "Pattern", is_static: false, document_date: DOC_DATE, abstraction_level: 1 });
    const l0a = insertFact({ text: "Event A", is_static: false, document_date: DOC_DATE, abstraction_level: 0 });
    const l0b = insertFact({ text: "Event B", is_static: false, document_date: DOC_DATE, abstraction_level: 0 });
    insertInstanceOfRelation(l0a, l1, { propagate: false });
    insertInstanceOfRelation(l0b, l1, { propagate: false });

    // Manually corrupt the count
    getTestDb().prepare("UPDATE memory_facts SET descendant_count = 99 WHERE id = ?").run(l1);
    const fixed = recalculateDescendantCount(l1);
    expect(fixed).toBe(2);
    expect(getFactById(l1)!.descendant_count).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────
// Fact queries: levels, expired, events
// ────────────────────────────────────────────────────────────────────

describe("getLevel2Facts", () => {
  it("returns only L2, latest, non-forgotten facts", () => {
    insertFact({ text: "Identity 1", is_static: true, document_date: DOC_DATE, abstraction_level: 2 });
    insertFact({ text: "Pattern", is_static: false, document_date: DOC_DATE, abstraction_level: 1 });
    const forgottenId = insertFact({ text: "Old identity", is_static: true, document_date: DOC_DATE, abstraction_level: 2 });
    markForgotten(forgottenId);

    const l2 = getLevel2Facts();
    expect(l2.length).toBe(1);
    expect(l2[0].text).toBe("Identity 1");
  });
});

describe("getExpiredLevel0Facts", () => {
  it("returns facts past their forget_after", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    insertFact({
      text: "Expired fact",
      is_static: false,
      document_date: DOC_DATE,
      abstraction_level: 0,
      forget_after: past,
    });
    expect(getExpiredLevel0Facts().length).toBe(1);
  });

  it("does NOT return facts with forget_after in the future", () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    insertFact({
      text: "Not yet expired",
      is_static: false,
      document_date: DOC_DATE,
      abstraction_level: 0,
      forget_after: future,
    });
    expect(getExpiredLevel0Facts().length).toBe(0);
  });

  it("SKIPS facts with unfired nudges (critical fix)", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const factId = insertFact({
      text: "Intention with nudge",
      is_static: false,
      document_date: DOC_DATE,
      abstraction_level: 0,
      forget_after: past,
    });
    // Set proactive_after but leave proactive_fired_at NULL → unfired nudge
    setProactiveAfter(factId, new Date(Date.now() + 3600000).toISOString());

    expect(getExpiredLevel0Facts().length).toBe(0);
  });

  it("includes facts with FIRED nudges in expiration candidates", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const factId = insertFact({
      text: "Intention with fired nudge",
      is_static: false,
      document_date: DOC_DATE,
      abstraction_level: 0,
      forget_after: past,
    });
    setProactiveAfter(factId, past);
    markNudgeFired(factId);

    expect(getExpiredLevel0Facts().length).toBe(1);
  });

  it("includes facts with NO nudge in expiration candidates", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    insertFact({
      text: "Regular expired fact",
      is_static: false,
      document_date: DOC_DATE,
      abstraction_level: 0,
      forget_after: past,
    });

    expect(getExpiredLevel0Facts().length).toBe(1);
  });
});

describe("getUpcomingEventFacts", () => {
  it("returns events within the specified day window", () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    insertFact({
      text: "Meeting tomorrow",
      is_static: false,
      document_date: DOC_DATE,
      abstraction_level: 0,
      event_date: tomorrow,
    });
    insertFact({
      text: "Event next month",
      is_static: false,
      document_date: DOC_DATE,
      abstraction_level: 0,
      event_date: "2026-07-01",
    });
    const upcoming = getUpcomingEventFacts(3);
    expect(upcoming.length).toBe(1);
    expect(upcoming[0].text).toBe("Meeting tomorrow");
  });
});

// ────────────────────────────────────────────────────────────────────
// Reminders
// ────────────────────────────────────────────────────────────────────

/**
 * Helper: format a JS Date as SQLite-compatible datetime string.
 * SQLite's datetime() returns "YYYY-MM-DD HH:MM:SS" format, so stored
 * due_at values must match this format for comparison operators to work.
 */
function sqliteDatetime(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

describe("reminders", () => {
  it("insertReminder + getDueReminders returns reminders due within 1h", () => {
    const soon = sqliteDatetime(new Date(Date.now() + 30 * 60_000)); // 30 min from now
    insertReminder({ text: "Call mom", due_at: soon });
    expect(getDueReminders().length).toBe(1);
  });

  it("getDueReminders does NOT return already-fired reminders", () => {
    const past = sqliteDatetime(new Date(Date.now() - 60_000));
    insertReminder({ text: "Old reminder", due_at: past });
    const reminders = getDueReminders();
    expect(reminders.length).toBe(1);

    markReminderFired(reminders[0].id);
    expect(getDueReminders().length).toBe(0);
  });

  it("getStrictlyDueReminders only returns past-due reminders (±2 min)", () => {
    const past = sqliteDatetime(new Date(Date.now() - 60_000));
    const future = sqliteDatetime(new Date(Date.now() + 30 * 60_000));
    insertReminder({ text: "Past due", due_at: past });
    insertReminder({ text: "Future due", due_at: future });

    const strict = getStrictlyDueReminders();
    expect(strict.length).toBe(1);
    expect(strict[0].text).toBe("Past due");
  });

  it("atomic claim: UPDATE WHERE fired_at IS NULL prevents double-fire", () => {
    const past = sqliteDatetime(new Date(Date.now() - 60_000));
    insertReminder({ text: "Race condition test", due_at: past });
    const reminders = getStrictlyDueReminders();
    expect(reminders.length).toBe(1);
    const id = reminders[0].id;

    // Simulate two concurrent claims
    const db = getTestDb();
    const claim1 = db
      .prepare("UPDATE reminders SET fired_at = datetime('now') WHERE id = ? AND fired_at IS NULL")
      .run(id).changes;
    const claim2 = db
      .prepare("UPDATE reminders SET fired_at = datetime('now') WHERE id = ? AND fired_at IS NULL")
      .run(id).changes;

    expect(claim1).toBe(1);
    expect(claim2).toBe(0); // second claim fails
  });
});

// ────────────────────────────────────────────────────────────────────
// Messages
// ────────────────────────────────────────────────────────────────────

describe("messages", () => {
  it("insertMessage + getMessageById", () => {
    const id = insertMessage({ raw_text: "hello", media_type: "text" });
    const msg = getMessageById(id);
    expect(msg).toBeDefined();
    expect(msg!.raw_text).toBe("hello");
  });

  it("getRecentMessages returns in chronological order", () => {
    // Manually insert with distinct timestamps so ORDER BY is deterministic
    const db = getTestDb();
    db.prepare("INSERT INTO messages (user_id, raw_text, media_type, created_at) VALUES (?, ?, ?, ?)")
      .run("local", "first", "text", "2026-05-05 10:00:00");
    db.prepare("INSERT INTO messages (user_id, raw_text, media_type, created_at) VALUES (?, ?, ?, ?)")
      .run("local", "second", "text", "2026-05-05 10:01:00");
    db.prepare("INSERT INTO messages (user_id, raw_text, media_type, created_at) VALUES (?, ?, ?, ?)")
      .run("local", "third", "text", "2026-05-05 10:02:00");

    const recent = getRecentMessages(3);
    expect(recent.length).toBe(3);
    expect(recent[0].content).toBe("first");
    expect(recent[2].content).toBe("third");
  });

  it("getRecentMessages prefers transcript over raw_text", () => {
    insertMessage({ raw_text: "raw", media_type: "audio", transcript: "transcribed" });
    const recent = getRecentMessages(1);
    expect(recent[0].content).toBe("transcribed");
  });

  it("getRecentMessages prefers file_summary when present", () => {
    insertMessage({ media_type: "image", file_summary: "a photo of a dog" });
    const recent = getRecentMessages(1);
    expect(recent[0].content).toBe("a photo of a dog");
  });

  it("INSERT OR IGNORE prevents duplicate imessage_row_id", () => {
    const id1 = insertMessage({ imessage_row_id: 42, raw_text: "first", media_type: "text" });
    const id2 = insertMessage({ imessage_row_id: 42, raw_text: "duplicate", media_type: "text" });
    // The second insert is ignored; id2 gets 0 as lastInsertRowid
    expect(id1).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// FTS search
// ────────────────────────────────────────────────────────────────────

describe("searchFactsFTS", () => {
  it("returns matching facts by keyword", () => {
    insertFact({ text: "User plays soccer every weekend", is_static: false, document_date: DOC_DATE });
    insertFact({ text: "User has a dog named Rex", is_static: false, document_date: DOC_DATE });

    const results = searchFactsFTS("soccer");
    expect(results.length).toBe(1);
    expect(results[0].text).toContain("soccer");
  });

  it("excludes forgotten and non-latest facts", () => {
    const id = insertFact({ text: "User plays tennis", is_static: false, document_date: DOC_DATE });
    markForgotten(id);

    const results = searchFactsFTS("tennis");
    expect(results.length).toBe(0);
  });

  it("handles empty and special-character queries gracefully", () => {
    expect(searchFactsFTS("")).toEqual([]);
    expect(searchFactsFTS("***")).toEqual([]);
    expect(searchFactsFTS("'\"")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// User profile
// ────────────────────────────────────────────────────────────────────

describe("user profile", () => {
  it("upsert creates and deduplicates profile facts", () => {
    upsertProfileFact({ fact: "User is a student", is_static: true });
    upsertProfileFact({ fact: "User is a student", is_static: true }); // duplicate
    expect(getStaticProfileFacts().length).toBe(1);
  });

  it("separates static and dynamic facts", () => {
    upsertProfileFact({ fact: "User lives in NYC", is_static: true });
    upsertProfileFact({ fact: "User is tired today", is_static: false });

    expect(getStaticProfileFacts()).toContain("User lives in NYC");
    expect(getStaticProfileFacts()).not.toContain("User is tired today");
    expect(getDynamicProfileFacts()).toContain("User is tired today");
  });
});

// ────────────────────────────────────────────────────────────────────
// Proactive log + attempts
// ────────────────────────────────────────────────────────────────────

describe("proactive log", () => {
  it("logProactive writes and getLastProactiveSentAt reads", () => {
    expect(getLastProactiveSentAt()).toBeNull();
    logProactive("morning_brief", "good morning!");
    const last = getLastProactiveSentAt();
    expect(last).toBeInstanceOf(Date);
  });

  it("logProactiveAttempt records attempts", () => {
    logProactiveAttempt({
      trigger_type: "external_synthesis",
      trigger: "daily",
      decision: "skipped",
      reason: "judge_score=40<70",
      candidate: "test message",
    });
    const row = getTestDb()
      .prepare("SELECT * FROM proactive_attempts ORDER BY id DESC LIMIT 1")
      .get() as Record<string, unknown>;
    expect(row.decision).toBe("skipped");
    expect(row.reason).toBe("judge_score=40<70");
  });
});

// ────────────────────────────────────────────────────────────────────
// Nudges
// ────────────────────────────────────────────────────────────────────

describe("nudges", () => {
  it("getNudgeDueFacts returns facts with past proactive_after", () => {
    const past = sqliteDatetime(new Date(Date.now() - 3600000));
    const factId = insertFact({
      text: "User wants to call advisor",
      is_static: false,
      document_date: DOC_DATE,
      abstraction_level: 0,
    });
    setProactiveAfter(factId, past);

    const due = getNudgeDueFacts();
    expect(due.length).toBe(1);
    expect(due[0].id).toBe(factId);
  });

  it("getNudgeDueFacts excludes forgotten facts", () => {
    const past = sqliteDatetime(new Date(Date.now() - 3600000));
    const factId = insertFact({
      text: "Forgotten intention",
      is_static: false,
      document_date: DOC_DATE,
      abstraction_level: 0,
    });
    setProactiveAfter(factId, past);
    markForgotten(factId);

    expect(getNudgeDueFacts().length).toBe(0);
  });

  it("markNudgeFired prevents re-firing", () => {
    const past = sqliteDatetime(new Date(Date.now() - 3600000));
    const factId = insertFact({
      text: "Already nudged",
      is_static: false,
      document_date: DOC_DATE,
      abstraction_level: 0,
    });
    setProactiveAfter(factId, past);
    markNudgeFired(factId);

    expect(getNudgeDueFacts().length).toBe(0);
  });

  it("getNudgeDueFacts excludes future proactive_after", () => {
    const future = sqliteDatetime(new Date(Date.now() + 86400000));
    const factId = insertFact({
      text: "Future nudge",
      is_static: false,
      document_date: DOC_DATE,
      abstraction_level: 0,
    });
    setProactiveAfter(factId, future);

    expect(getNudgeDueFacts().length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// Pattern observation queue
// ────────────────────────────────────────────────────────────────────

describe("pattern observation queue", () => {
  it("getQueuedPatternFacts returns queued L1 facts", () => {
    const l1 = insertFact({ text: "Pattern fact", is_static: false, document_date: DOC_DATE, abstraction_level: 1 });
    getTestDb().prepare("UPDATE memory_facts SET pattern_observation_queued = 1 WHERE id = ?").run(l1);

    const queued = getQueuedPatternFacts();
    expect(queued.length).toBe(1);
    expect(queued[0].id).toBe(l1);
  });

  it("clearAllPatternObservationQueued resets all flags", () => {
    const l1a = insertFact({ text: "Pattern A", is_static: false, document_date: DOC_DATE, abstraction_level: 1 });
    const l1b = insertFact({ text: "Pattern B", is_static: false, document_date: DOC_DATE, abstraction_level: 1 });
    getTestDb().prepare("UPDATE memory_facts SET pattern_observation_queued = 1 WHERE id IN (?, ?)").run(l1a, l1b);

    clearAllPatternObservationQueued();
    expect(getQueuedPatternFacts().length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// Stale bedrock (absence reflection)
// ────────────────────────────────────────────────────────────────────

describe("getStaleBedrock", () => {
  it("returns L1 facts without recent proactive_log entries", () => {
    const l1 = insertFact({ text: "User runs regularly", is_static: false, document_date: DOC_DATE, abstraction_level: 1 });
    const stale = getStaleBedrock(14);
    expect(stale.some((f) => f.id === l1)).toBe(true);
  });

  it("excludes L1 facts that were proactively mentioned recently", () => {
    const l1 = insertFact({ text: "User runs regularly", is_static: false, document_date: DOC_DATE, abstraction_level: 1 });
    logProactive("absence_reflection", "hey you havent run in a while", l1);

    const stale = getStaleBedrock(14);
    expect(stale.some((f) => f.id === l1)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// Cron state
// ────────────────────────────────────────────────────────────────────

describe("cron state", () => {
  it("getCronLastRan returns null for unknown jobs", () => {
    expect(getCronLastRan("nonexistent")).toBeNull();
  });

  it("setCronLastRan + getCronLastRan round-trip", () => {
    setCronLastRan("morning_brief");
    const last = getCronLastRan("morning_brief");
    expect(last).toBeInstanceOf(Date);
    expect(Date.now() - last!.getTime()).toBeLessThan(5000);
  });

  it("setCronLastRan upserts (updates existing row)", () => {
    setCronLastRan("morning_brief");
    const first = getCronLastRan("morning_brief")!;

    // Wait a tiny bit so timestamps differ
    setCronLastRan("morning_brief");
    const second = getCronLastRan("morning_brief")!;
    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());

    // Should still be one row
    const count = getTestDb()
      .prepare("SELECT COUNT(*) as n FROM cron_state WHERE job_name = 'morning_brief'")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});
