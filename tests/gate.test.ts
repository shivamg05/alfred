/**
 * Tests for src/proactive/gate.ts — quiet hours, minimum gap enforcement,
 * timezone-aware hour calculation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, teardownTestDb, getTestDb } from "./setup.js";

import { evaluateProactiveGate } from "../src/proactive/gate.js";
import { logProactive } from "../src/memory/facts.js";

beforeEach(() => setupTestDb());
afterEach(() => {
  teardownTestDb();
  vi.useRealTimers();
});

describe("evaluateProactiveGate", () => {
  it("blocks empty content", () => {
    const result = evaluateProactiveGate("");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("empty_content");
  });

  it("blocks whitespace-only content", () => {
    const result = evaluateProactiveGate("   \n  ");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("empty_content");
  });

  it("allows message when outside quiet hours and no recent proactive", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T14:00:00-04:00"));

    const result = evaluateProactiveGate("hey what's up");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("allowed");
  });

  it("blocks during quiet hours", () => {
    vi.useFakeTimers();
    // 2am ET = should be blocked (quiet hours 23-8)
    vi.setSystemTime(new Date("2026-05-05T02:00:00-04:00"));

    const result = evaluateProactiveGate("midnight message");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("quiet_hours");
  });

  it("blocks when sent within 3-hour gap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T14:00:00-04:00"));

    // Log a proactive message and backdate it to 1h ago
    logProactive("morning_brief", "good morning!");
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    getTestDb().prepare("UPDATE proactive_log SET sent_at = ?").run(oneHourAgo);

    const result = evaluateProactiveGate("follow up message");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("min_gap");
  });

  it("allows when gap exceeds 3 hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T14:00:00-04:00"));

    // Log a proactive message and backdate it to 4h ago
    logProactive("morning_brief", "good morning!");
    const fourHoursAgo = new Date(Date.now() - 4 * 3600000).toISOString();
    getTestDb().prepare("UPDATE proactive_log SET sent_at = ?").run(fourHoursAgo);

    const result = evaluateProactiveGate("afternoon message");
    expect(result.allowed).toBe(true);
  });

  it("uses USER_TIMEZONE for quiet hour check, not system time", () => {
    vi.useFakeTimers();
    // 3am UTC = 11pm ET (previous day) → INSIDE quiet hours for ET (23-8)
    vi.setSystemTime(new Date("2026-05-05T03:00:00Z"));

    const result = evaluateProactiveGate("should be blocked in ET");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("quiet_hours");
  });
});

describe("quiet hours edge cases", () => {
  it("handles wrap-around quiet hours (23:00 to 08:00)", () => {
    vi.useFakeTimers();

    // 11pm ET = quiet
    vi.setSystemTime(new Date("2026-05-05T23:00:00-04:00"));
    expect(evaluateProactiveGate("late night").allowed).toBe(false);

    // 7am ET = still quiet
    vi.setSystemTime(new Date("2026-05-06T07:00:00-04:00"));
    expect(evaluateProactiveGate("early morning").allowed).toBe(false);

    // 8am ET = boundary, should be allowed (end is exclusive)
    vi.setSystemTime(new Date("2026-05-06T08:00:00-04:00"));
    expect(evaluateProactiveGate("morning start").allowed).toBe(true);

    // 10pm ET = before quiet hours start
    vi.setSystemTime(new Date("2026-05-05T22:00:00-04:00"));
    expect(evaluateProactiveGate("still evening").allowed).toBe(true);
  });
});
