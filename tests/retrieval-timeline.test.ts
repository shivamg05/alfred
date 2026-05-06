/**
 * Tests for timeline annotations in src/memory/retrieval.ts:
 * - relativeTimeTag() for event dates and mention staleness
 * - formatWithTimeline() for fact annotation logic
 *
 * Uses fake timers to control "now" for deterministic assertions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, teardownTestDb } from "./setup.js";

// Mock ChromaDB — retrieval.ts imports it
vi.mock("../src/memory/vectors.js", () => ({
  querySimilarFacts: vi.fn().mockResolvedValue([]),
}));

import { relativeTimeTag, formatWithTimeline } from "../src/memory/retrieval.js";
import type { MemoryFact } from "../src/memory/facts.js";

beforeEach(() => {
  setupTestDb();
  vi.useFakeTimers();
  // Pin "now" to 2026-05-06 noon ET (16:00 UTC)
  vi.setSystemTime(new Date("2026-05-06T16:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  teardownTestDb();
});

function makeFact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: 1,
    text: "User has a meeting with advisor",
    is_static: false,
    is_latest: true,
    is_forgotten: false,
    document_date: "2026-05-06T12:00:00Z",
    abstraction_level: 0,
    descendant_count: 0,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// relativeTimeTag — event dates
// ────────────────────────────────────────────────────────────────────

describe("relativeTimeTag (event)", () => {
  it("returns 'today' for same-day events", () => {
    expect(relativeTimeTag("2026-05-06T18:00:00Z", "event")).toBe("today");
  });

  it("returns 'tomorrow' for next-day events", () => {
    expect(relativeTimeTag("2026-05-07T10:00:00Z", "event")).toBe("tomorrow");
  });

  it("returns 'yesterday' for previous-day events", () => {
    expect(relativeTimeTag("2026-05-05T10:00:00Z", "event")).toBe("yesterday");
  });

  it("returns 'in N days' for 2-7 day future events", () => {
    expect(relativeTimeTag("2026-05-08T10:00:00Z", "event")).toBe("in 2 days");
    expect(relativeTimeTag("2026-05-10T10:00:00Z", "event")).toBe("in 4 days");
    expect(relativeTimeTag("2026-05-13T10:00:00Z", "event")).toBe("in 7 days");
  });

  it("returns 'next week' for 8-14 day future events", () => {
    expect(relativeTimeTag("2026-05-16T10:00:00Z", "event")).toBe("next week");
  });

  it("returns 'in ~N weeks' for 15-30 day future events", () => {
    expect(relativeTimeTag("2026-05-25T10:00:00Z", "event")).toMatch(/in ~\d+ weeks/);
  });

  it("returns 'in ~N months' for 30+ day future events", () => {
    expect(relativeTimeTag("2026-07-06T10:00:00Z", "event")).toMatch(/in ~\d+ months/);
  });

  it("returns 'N days ago' for 2-7 day past events", () => {
    expect(relativeTimeTag("2026-05-04T10:00:00Z", "event")).toBe("2 days ago");
    expect(relativeTimeTag("2026-05-01T10:00:00Z", "event")).toBe("5 days ago");
  });

  it("returns 'last week' for 8-14 day past events", () => {
    expect(relativeTimeTag("2026-04-28T10:00:00Z", "event")).toBe("last week");
  });

  it("returns 'N weeks ago' for 15-60 day past events", () => {
    expect(relativeTimeTag("2026-04-10T10:00:00Z", "event")).toMatch(/\d+ weeks ago/);
  });

  it("returns 'N months ago' for 60+ day past events", () => {
    expect(relativeTimeTag("2026-02-01T10:00:00Z", "event")).toMatch(/\d+ months ago/);
  });

  it("returns null for invalid date string", () => {
    expect(relativeTimeTag("not-a-date", "event")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(relativeTimeTag("", "event")).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// relativeTimeTag — mention staleness
// ────────────────────────────────────────────────────────────────────

describe("relativeTimeTag (mentioned)", () => {
  it("returns null for today (fresh)", () => {
    expect(relativeTimeTag("2026-05-06T12:00:00Z", "mentioned")).toBeNull();
  });

  it("returns null for yesterday (still fresh)", () => {
    expect(relativeTimeTag("2026-05-05T12:00:00Z", "mentioned")).toBeNull();
  });

  it("returns null for within-a-week mentions", () => {
    expect(relativeTimeTag("2026-05-01T12:00:00Z", "mentioned")).toBeNull();
  });

  it("returns 'mentioned Nw ago' for 8-30 day old mentions", () => {
    expect(relativeTimeTag("2026-04-20T12:00:00Z", "mentioned")).toMatch(/mentioned \d+w ago/);
  });

  it("returns 'mentioned ~Nmo ago' for 31-90 day old mentions", () => {
    expect(relativeTimeTag("2026-03-15T12:00:00Z", "mentioned")).toMatch(/mentioned ~\d+mo ago/);
  });

  it("returns stale warning for 90+ day old mentions", () => {
    expect(relativeTimeTag("2026-01-01T12:00:00Z", "mentioned")).toMatch(/may be stale/);
  });
});

// ────────────────────────────────────────────────────────────────────
// formatWithTimeline — fact annotation
// ────────────────────────────────────────────────────────────────────

describe("formatWithTimeline", () => {
  it("annotates L0 fact with event_date", () => {
    const fact = makeFact({ event_date: "2026-05-07T14:00:00Z" });
    expect(formatWithTimeline(fact)).toBe("User has a meeting with advisor [tomorrow]");
  });

  it("annotates L0 fact with today event_date", () => {
    const fact = makeFact({ event_date: "2026-05-06T18:00:00Z" });
    expect(formatWithTimeline(fact)).toBe("User has a meeting with advisor [today]");
  });

  it("annotates L0 fact with past event_date", () => {
    const fact = makeFact({ event_date: "2026-05-05T14:00:00Z" });
    expect(formatWithTimeline(fact)).toBe("User has a meeting with advisor [yesterday]");
  });

  it("event_date takes priority over document_date staleness", () => {
    const fact = makeFact({
      document_date: "2026-01-01T12:00:00Z", // very old
      event_date: "2026-05-07T14:00:00Z",    // tomorrow
    });
    expect(formatWithTimeline(fact)).toContain("[tomorrow]");
    expect(formatWithTimeline(fact)).not.toContain("stale");
  });

  it("annotates stale L0 fact via document_date when no event_date", () => {
    const fact = makeFact({
      document_date: "2026-01-01T12:00:00Z", // ~4 months old
      event_date: undefined,
    });
    const result = formatWithTimeline(fact);
    expect(result).toContain("[mentioned");
    expect(result).toContain("may be stale");
  });

  it("annotates L0 fact with medium-age document_date", () => {
    const fact = makeFact({
      document_date: "2026-04-15T12:00:00Z", // ~3 weeks old
      event_date: undefined,
    });
    const result = formatWithTimeline(fact);
    expect(result).toContain("[mentioned");
    expect(result).toContain("w ago");
  });

  it("does NOT annotate fresh L0 fact", () => {
    const fact = makeFact({
      document_date: "2026-05-05T12:00:00Z", // yesterday
      event_date: undefined,
    });
    expect(formatWithTimeline(fact)).toBe("User has a meeting with advisor");
  });

  it("does NOT annotate L1 pattern facts", () => {
    const fact = makeFact({
      text: "User runs every morning",
      abstraction_level: 1,
      document_date: "2026-01-01T12:00:00Z", // very old
      event_date: undefined,
    });
    expect(formatWithTimeline(fact)).toBe("User runs every morning");
  });

  it("does NOT annotate L2 identity facts", () => {
    const fact = makeFact({
      text: "User is a CS student",
      abstraction_level: 2,
      document_date: "2025-01-01T12:00:00Z", // very old
      event_date: undefined,
    });
    expect(formatWithTimeline(fact)).toBe("User is a CS student");
  });

  it("L1 fact WITH event_date still gets annotated", () => {
    const fact = makeFact({
      text: "User has weekly advisor meetings",
      abstraction_level: 1,
      event_date: "2026-05-07T14:00:00Z",
    });
    expect(formatWithTimeline(fact)).toContain("[tomorrow]");
  });
});
