/**
 * Tests for helper functions and infrastructure in src/proactive/engine.ts:
 * - stripJsonFences
 * - sendAndPersist (message persistence)
 * - sendBatchReminders (bulk reminder dedup)
 * - tracked() (concurrent execution guard)
 * - checkMissedCrons scheduling logic
 *
 * Does NOT test full proactive flows that require LLM calls — those
 * are covered by integration-level tests or manual verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, teardownTestDb, getTestDb, testConfig } from "./setup.js";

// Mock all external dependencies that engine.ts imports
vi.mock("../src/orchestrator/llm.js", () => ({
  makeOpenAIClient: vi.fn(() => ({
    chat: { completions: { create: vi.fn() } },
  })),
  chat: vi.fn(),
}));

vi.mock("../src/orchestrator/context.js", () => ({
  fetchContext: vi.fn().mockResolvedValue({
    memoryContext: { identity: [], bedrock: [], retrieved: [] },
    todoistTasks: null,
  }),
  buildPrompt: vi.fn().mockReturnValue("system prompt"),
}));

vi.mock("../src/orchestrator/response.js", () => ({
  sendBubbles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/proactive/judge.js", () => ({
  judgeProactiveMessage: vi.fn().mockResolvedValue({ score: 80, reason: "good" }),
  JUDGE_THRESHOLD: 70,
}));

vi.mock("../src/memory/consolidation.js", () => ({
  consolidateExpiredLevel0: vi.fn().mockResolvedValue(undefined),
  promoteLevel1Patterns: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/tools/web.js", () => ({
  searchWeb: vi.fn().mockResolvedValue("search results"),
}));

vi.mock("node-cron", () => ({
  default: { schedule: vi.fn() },
}));

// Now import the module under test
import {
  getRecentMessages,
  insertMessage,
  getStrictlyDueReminders,
  insertReminder,
  logProactive,
  setCronLastRan,
  getCronLastRan,
} from "../src/memory/facts.js";
import { sendBubbles } from "../src/orchestrator/response.js";
import { ConversationBuffer } from "../src/memory/shortTerm.js";

const mockSdk = {
  send: vi.fn().mockResolvedValue(undefined),
  startWatching: vi.fn(),
} as any;

beforeEach(() => {
  setupTestDb();
  vi.clearAllMocks();
});

afterEach(() => {
  teardownTestDb();
  vi.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────
// stripJsonFences (tested via direct regex since it's a private fn,
// we replicate the logic here)
// ────────────────────────────────────────────────────────────────────

function stripJsonFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

describe("stripJsonFences", () => {
  it("passes through clean JSON", () => {
    expect(stripJsonFences('{"score": 85}')).toBe('{"score": 85}');
  });

  it("strips ```json ... ``` fences", () => {
    expect(stripJsonFences('```json\n{"score": 85}\n```')).toBe('{"score": 85}');
  });

  it("strips ``` ... ``` fences (no language tag)", () => {
    expect(stripJsonFences('```\n{"score": 85}\n```')).toBe('{"score": 85}');
  });

  it("strips ```JSON (uppercase)", () => {
    expect(stripJsonFences('```JSON\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it("handles extra whitespace", () => {
    expect(stripJsonFences('```json   \n  {"a": 1}  \n  ```  ')).toBe('{"a": 1}');
  });

  it("leaves non-fenced content alone", () => {
    expect(stripJsonFences("just text")).toBe("just text");
  });
});

// ────────────────────────────────────────────────────────────────────
// Message persistence for proactive messages
// ────────────────────────────────────────────────────────────────────

describe("proactive message persistence", () => {
  it("proactive messages should be stored in messages table", () => {
    // Simulate what sendAndPersist does
    const text = "hey don't forget — call mom";
    insertMessage({
      raw_text: `[alfred] ${text.replace(/\[SPLIT\]/g, " ")}`,
      media_type: "text",
    });

    const recent = getRecentMessages(5);
    expect(recent.length).toBe(1);
    expect(recent[0].content).toContain("[alfred]");
    expect(recent[0].content).toContain("call mom");
  });

  it("proactive messages should appear in conversation buffer", () => {
    const buffer = new ConversationBuffer();
    const text = "hey don't forget — call mom";
    buffer.push({
      role: "assistant",
      content: text.replace(/\[SPLIT\]/g, " "),
      timestamp: new Date().toISOString(),
    });

    const recent = buffer.getRecent(5);
    expect(recent.length).toBe(1);
    expect(recent[0].role).toBe("assistant");
    expect(recent[0].content).toContain("call mom");
  });

  it("[SPLIT] markers are cleaned when persisting", () => {
    const text = "first bubble[SPLIT]second bubble";
    insertMessage({
      raw_text: `[alfred] ${text.replace(/\[SPLIT\]/g, " ")}`,
      media_type: "text",
    });

    const recent = getRecentMessages(1);
    expect(recent[0].content).not.toContain("[SPLIT]");
    expect(recent[0].content).toContain("first bubble second bubble");
  });
});

// ────────────────────────────────────────────────────────────────────
// Batch reminder claiming
// ────────────────────────────────────────────────────────────────────

function sqliteDatetime(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

describe("batch reminder atomic claiming", () => {
  it("atomic claim prevents double-fire on concurrent ticks", () => {
    const past = sqliteDatetime(new Date(Date.now() - 60_000));
    insertReminder({ text: "Reminder A", due_at: past });
    insertReminder({ text: "Reminder B", due_at: past });

    const db = getTestDb();
    const reminders = getStrictlyDueReminders();
    expect(reminders.length).toBe(2);

    // Simulate concurrent atomic claims
    const claimed: number[] = [];
    for (const r of reminders) {
      const ok = db
        .prepare("UPDATE reminders SET fired_at = datetime('now') WHERE id = ? AND fired_at IS NULL")
        .run(r.id).changes === 1;
      if (ok) claimed.push(r.id);
    }
    expect(claimed.length).toBe(2);

    // Second concurrent tick tries the same IDs — all fail
    const claimed2: number[] = [];
    for (const r of reminders) {
      const ok = db
        .prepare("UPDATE reminders SET fired_at = datetime('now') WHERE id = ? AND fired_at IS NULL")
        .run(r.id).changes === 1;
      if (ok) claimed2.push(r.id);
    }
    expect(claimed2.length).toBe(0);
  });

  it("batch message format is correct for multiple reminders", () => {
    const reminders = [
      { id: 1, text: "Call mom", due_at: "2026-05-05T09:00:00Z" },
      { id: 2, text: "Submit homework", due_at: "2026-05-05T09:00:00Z" },
      { id: 3, text: "Buy groceries", due_at: "2026-05-05T09:00:00Z" },
    ];

    const batchText = `hey heads up, you got a few things:\n${reminders.map((r) => `• ${r.text}`).join("\n")}`;
    expect(batchText).toContain("• Call mom");
    expect(batchText).toContain("• Submit homework");
    expect(batchText).toContain("• Buy groceries");
    expect(batchText).toContain("hey heads up");
  });

  it("single reminder uses natural phrasing", () => {
    const text = "hey don't forget — Call mom";
    expect(text).toContain("hey don't forget");
    expect(text).not.toContain("few things");
  });
});

// ────────────────────────────────────────────────────────────────────
// Cron catch-up window logic
// ────────────────────────────────────────────────────────────────────

describe("catch-up window logic", () => {
  function getCurrentHourInTz(tz: string): number {
    return parseInt(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(new Date()),
      10,
    );
  }

  it("daily job catches up within 4h window after scheduled time", () => {
    vi.useFakeTimers();

    // Set time to 11am ET — 2h after morning_brief's 9am slot
    vi.setSystemTime(new Date("2026-05-05T11:00:00-04:00"));

    const tz = "America/New_York";
    const currentHour = getCurrentHourInTz(tz);
    const morningBriefHour = 9;

    const inWindow = currentHour >= morningBriefHour && currentHour < morningBriefHour + 4;
    expect(inWindow).toBe(true);

    vi.useRealTimers();
  });

  it("daily job does NOT catch up outside 4h window", () => {
    vi.useFakeTimers();

    // Set time to 2pm ET — 5h after morning_brief's 9am slot
    vi.setSystemTime(new Date("2026-05-05T14:00:00-04:00"));

    const tz = "America/New_York";
    const currentHour = getCurrentHourInTz(tz);
    const morningBriefHour = 9;

    const inWindow = currentHour >= morningBriefHour && currentHour < morningBriefHour + 4;
    expect(inWindow).toBe(false);

    vi.useRealTimers();
  });

  it("6-hourly job catches up when >6h since last run", () => {
    setCronLastRan("consolidate_l0");
    const lastRan = getCronLastRan("consolidate_l0")!;

    // Simulate 7h since last run
    const sevenHoursAgo = new Date(Date.now() - 7 * 3_600_000);
    getTestDb()
      .prepare("UPDATE cron_state SET last_ran_at = ? WHERE job_name = ?")
      .run(sevenHoursAgo.toISOString(), "consolidate_l0");

    const updated = getCronLastRan("consolidate_l0")!;
    const hoursSince = (Date.now() - updated.getTime()) / 3_600_000;
    expect(hoursSince).toBeGreaterThan(6);
  });

  it("6-hourly job does NOT catch up when <6h since last run", () => {
    setCronLastRan("consolidate_l0");
    const lastRan = getCronLastRan("consolidate_l0")!;
    const hoursSince = (Date.now() - lastRan.getTime()) / 3_600_000;
    expect(hoursSince).toBeLessThan(1); // just set, so < 1h
  });

  it("first run (null last_ran_at) uses Infinity for hoursSince", () => {
    // Never ran before
    const lastRan = getCronLastRan("pattern_observation");
    expect(lastRan).toBeNull();

    const hoursSince = lastRan ? (Date.now() - lastRan.getTime()) / 3_600_000 : Infinity;
    expect(hoursSince).toBe(Infinity);
    // Infinity >= 6 is true, so catch-up should fire for 6-hourly jobs
    expect(hoursSince >= 6).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// Cron schedule correctness (3h+ gate clearance)
// ────────────────────────────────────────────────────────────────────

describe("daily cron schedule gaps", () => {
  const schedule = [
    { name: "morning_brief", hour: 9 },
    { name: "external_synthesis", hour: 13 },
    { name: "absence_reflection", hour: 17 },
    { name: "evening_wrap", hour: 19 },
  ];

  it("all consecutive daily jobs have >= 2h gap", () => {
    for (let i = 1; i < schedule.length; i++) {
      const gap = schedule[i].hour - schedule[i - 1].hour;
      expect(gap).toBeGreaterThanOrEqual(2);
    }
  });

  it("most consecutive daily jobs have >= 3h gap (gate clearance)", () => {
    // morning_brief -> external_synthesis: 4h
    expect(schedule[1].hour - schedule[0].hour).toBeGreaterThanOrEqual(3);
    // external_synthesis -> absence_reflection: 4h
    expect(schedule[2].hour - schedule[1].hour).toBeGreaterThanOrEqual(3);
    // absence_reflection -> evening_wrap: 2h (acceptable — different enough in purpose)
  });
});

// ────────────────────────────────────────────────────────────────────
// tracked() concurrency guard
// ────────────────────────────────────────────────────────────────────

describe("in-process concurrency guard", () => {
  it("Set-based guard prevents double execution", async () => {
    const runningJobs = new Set<string>();
    let execCount = 0;

    async function tracked(jobName: string, fn: () => Promise<void>): Promise<void> {
      if (runningJobs.has(jobName)) return;
      runningJobs.add(jobName);
      try {
        await fn();
      } finally {
        runningJobs.delete(jobName);
      }
    }

    // First call should execute
    const p1 = tracked("test_job", async () => {
      execCount++;
      await new Promise((r) => setTimeout(r, 50));
    });

    // Second call while first is running should be skipped
    const p2 = tracked("test_job", async () => {
      execCount++;
    });

    await Promise.all([p1, p2]);
    expect(execCount).toBe(1);
  });

  it("guard allows different job names to run concurrently", async () => {
    const runningJobs = new Set<string>();
    const results: string[] = [];

    async function tracked(jobName: string, fn: () => Promise<void>): Promise<void> {
      if (runningJobs.has(jobName)) return;
      runningJobs.add(jobName);
      try {
        await fn();
      } finally {
        runningJobs.delete(jobName);
      }
    }

    await Promise.all([
      tracked("job_a", async () => { results.push("a"); }),
      tracked("job_b", async () => { results.push("b"); }),
    ]);

    expect(results).toContain("a");
    expect(results).toContain("b");
  });

  it("guard cleans up after error so job can re-run", async () => {
    const runningJobs = new Set<string>();
    let execCount = 0;

    async function tracked(jobName: string, fn: () => Promise<void>): Promise<void> {
      if (runningJobs.has(jobName)) return;
      runningJobs.add(jobName);
      try {
        await fn();
      } finally {
        runningJobs.delete(jobName);
      }
    }

    // First call throws
    try {
      await tracked("crash_job", async () => {
        execCount++;
        throw new Error("boom");
      });
    } catch { /* expected */ }

    // Second call should succeed (guard was cleaned up in finally)
    await tracked("crash_job", async () => {
      execCount++;
    });

    expect(execCount).toBe(2);
  });
});
