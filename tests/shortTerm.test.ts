/**
 * Tests for src/memory/shortTerm.ts — ConversationBuffer behavior:
 * capacity, session gap reset, seed, recent retrieval, prompt injection cap,
 * and session summary generation.
 */

import { describe, it, expect, vi } from "vitest";
import { ConversationBuffer } from "../src/memory/shortTerm.js";

function msg(role: "user" | "assistant", content: string, timestamp: string) {
  return { role, content, timestamp };
}

describe("ConversationBuffer", () => {
  it("stores and retrieves messages in order", () => {
    const buf = new ConversationBuffer();
    buf.push(msg("user", "hello", "2026-05-05T10:00:00Z"));
    buf.push(msg("assistant", "hey!", "2026-05-05T10:00:01Z"));

    const recent = buf.getRecent();
    expect(recent.length).toBe(2);
    expect(recent[0].content).toBe("hello");
    expect(recent[1].content).toBe("hey!");
  });

  it("caps at 20 messages (BUFFER_SIZE)", () => {
    const buf = new ConversationBuffer();
    const base = new Date("2026-05-05T10:00:00Z").getTime();
    for (let i = 0; i < 25; i++) {
      buf.push(msg("user", `msg-${i}`, new Date(base + i * 1000).toISOString()));
    }

    const recent = buf.getRecent();
    expect(recent.length).toBe(20);
    expect(recent[0].content).toBe("msg-5"); // oldest kept
    expect(recent[19].content).toBe("msg-24"); // newest
  });

  it("resets after 4h silence gap (SESSION_GAP_HOURS)", () => {
    const buf = new ConversationBuffer();
    buf.push(msg("user", "morning msg", "2026-05-05T09:00:00Z"));
    buf.push(msg("assistant", "morning reply", "2026-05-05T09:00:01Z"));

    // 5 hours later
    buf.push(msg("user", "afternoon msg", "2026-05-05T14:00:01Z"));

    const recent = buf.getRecent();
    expect(recent.length).toBe(1); // buffer was reset
    expect(recent[0].content).toBe("afternoon msg");
  });

  it("does NOT reset when gap is under 4h", () => {
    const buf = new ConversationBuffer();
    buf.push(msg("user", "first", "2026-05-05T09:00:00Z"));
    buf.push(msg("user", "second", "2026-05-05T12:59:00Z")); // 3h59m later

    const recent = buf.getRecent();
    expect(recent.length).toBe(2);
  });

  it("getRecent(n) returns the last n messages", () => {
    const buf = new ConversationBuffer();
    const base = new Date("2026-05-05T10:00:00Z").getTime();
    for (let i = 0; i < 10; i++) {
      buf.push(msg("user", `msg-${i}`, new Date(base + i * 1000).toISOString()));
    }

    const last3 = buf.getRecent(3);
    expect(last3.length).toBe(3);
    expect(last3[0].content).toBe("msg-7");
    expect(last3[2].content).toBe("msg-9");
  });

  it("seed pre-populates the buffer", () => {
    const buf = new ConversationBuffer();
    buf.seed([
      msg("user", "seeded-1", "2026-05-05T08:00:00Z"),
      msg("assistant", "seeded-2", "2026-05-05T08:00:01Z"),
    ]);

    const recent = buf.getRecent();
    expect(recent.length).toBe(2);
    expect(recent[0].content).toBe("seeded-1");
  });

  it("seed truncates to BUFFER_SIZE", () => {
    const buf = new ConversationBuffer();
    const msgs = Array.from({ length: 30 }, (_, i) =>
      msg("user", `seed-${i}`, new Date(Date.now() + i * 1000).toISOString()),
    );
    buf.seed(msgs);

    expect(buf.getRecent().length).toBe(20);
    expect(buf.getRecent()[0].content).toBe("seed-10"); // last 20
  });

  it("push after seed continues normally", () => {
    const buf = new ConversationBuffer();
    buf.seed([msg("user", "old", "2026-05-05T10:00:00Z")]);
    buf.push(msg("user", "new", "2026-05-05T10:01:00Z"));

    expect(buf.getRecent().length).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────
// Prompt injection cap (getForPrompt)
// ────────────────────────────────────────────────────────────────────

describe("getForPrompt (injection cap)", () => {
  it("returns all messages when under INJECTION_CAP", () => {
    const buf = new ConversationBuffer();
    const base = new Date("2026-05-05T10:00:00Z").getTime();
    for (let i = 0; i < 8; i++) {
      buf.push(msg("user", `msg-${i}`, new Date(base + i * 1000).toISOString()));
    }

    const forPrompt = buf.getForPrompt();
    expect(forPrompt.length).toBe(8);
    expect(forPrompt[0].content).toBe("msg-0");
  });

  it("returns exactly INJECTION_CAP messages when buffer is full", () => {
    const buf = new ConversationBuffer();
    const base = new Date("2026-05-05T10:00:00Z").getTime();
    for (let i = 0; i < 20; i++) {
      buf.push(msg("user", `msg-${i}`, new Date(base + i * 1000).toISOString()));
    }

    const forPrompt = buf.getForPrompt();
    expect(forPrompt.length).toBe(ConversationBuffer.INJECTION_CAP);
    // Should be the LAST 12 messages
    expect(forPrompt[0].content).toBe("msg-8");
    expect(forPrompt[forPrompt.length - 1].content).toBe("msg-19");
  });

  it("getRecent still returns all 20 messages (for extraction)", () => {
    const buf = new ConversationBuffer();
    const base = new Date("2026-05-05T10:00:00Z").getTime();
    for (let i = 0; i < 20; i++) {
      buf.push(msg("user", `msg-${i}`, new Date(base + i * 1000).toISOString()));
    }

    expect(buf.getRecent().length).toBe(20);
    expect(buf.getForPrompt().length).toBe(12);
  });

  it("INJECTION_CAP is 12", () => {
    expect(ConversationBuffer.INJECTION_CAP).toBe(12);
  });
});

// ────────────────────────────────────────────────────────────────────
// Session summary
// ────────────────────────────────────────────────────────────────────

describe("session summary", () => {
  it("starts with null sessionSummary", () => {
    const buf = new ConversationBuffer();
    expect(buf.sessionSummary).toBeNull();
  });

  it("triggers summarizer when buffer exceeds INJECTION_CAP", async () => {
    const buf = new ConversationBuffer();
    const summarizer = vi.fn().mockResolvedValue("they talked about work stuff");
    buf.onNeedsSummary(summarizer);

    const base = new Date("2026-05-05T10:00:00Z").getTime();
    for (let i = 0; i < 13; i++) {
      buf.push(msg("user", `msg-${i}`, new Date(base + i * 1000).toISOString()));
    }

    // Wait for async summary to complete
    await vi.waitFor(() => {
      expect(buf.sessionSummary).toBe("they talked about work stuff");
    });

    expect(summarizer).toHaveBeenCalledTimes(1);
    // Should have been called with the overflow messages (first 1 message)
    const overflowMsgs = summarizer.mock.calls[0][0];
    expect(overflowMsgs.length).toBe(1);
    expect(overflowMsgs[0].content).toBe("msg-0");
  });

  it("does NOT trigger summarizer when under INJECTION_CAP", () => {
    const buf = new ConversationBuffer();
    const summarizer = vi.fn().mockResolvedValue("summary");
    buf.onNeedsSummary(summarizer);

    const base = new Date("2026-05-05T10:00:00Z").getTime();
    for (let i = 0; i < 10; i++) {
      buf.push(msg("user", `msg-${i}`, new Date(base + i * 1000).toISOString()));
    }

    expect(summarizer).not.toHaveBeenCalled();
    expect(buf.sessionSummary).toBeNull();
  });

  it("does NOT trigger summarizer if none registered", () => {
    const buf = new ConversationBuffer();
    const base = new Date("2026-05-05T10:00:00Z").getTime();
    // No crash when pushing past cap without a summarizer
    for (let i = 0; i < 15; i++) {
      buf.push(msg("user", `msg-${i}`, new Date(base + i * 1000).toISOString()));
    }
    expect(buf.sessionSummary).toBeNull();
  });

  it("clears sessionSummary on 4h gap reset", async () => {
    const buf = new ConversationBuffer();
    const summarizer = vi.fn().mockResolvedValue("old summary");
    buf.onNeedsSummary(summarizer);

    const base = new Date("2026-05-05T10:00:00Z").getTime();
    for (let i = 0; i < 13; i++) {
      buf.push(msg("user", `msg-${i}`, new Date(base + i * 1000).toISOString()));
    }

    await vi.waitFor(() => {
      expect(buf.sessionSummary).toBe("old summary");
    });

    // 5 hours later — triggers session reset
    buf.push(msg("user", "new session", new Date(base + 5 * 3600 * 1000).toISOString()));
    expect(buf.sessionSummary).toBeNull();
    expect(buf.getRecent().length).toBe(1);
  });

  it("seed clears sessionSummary", async () => {
    const buf = new ConversationBuffer();
    const summarizer = vi.fn().mockResolvedValue("some summary");
    buf.onNeedsSummary(summarizer);

    const base = new Date("2026-05-05T10:00:00Z").getTime();
    for (let i = 0; i < 13; i++) {
      buf.push(msg("user", `msg-${i}`, new Date(base + i * 1000).toISOString()));
    }

    await vi.waitFor(() => {
      expect(buf.sessionSummary).toBe("some summary");
    });

    buf.seed([msg("user", "fresh start", "2026-05-06T10:00:00Z")]);
    expect(buf.sessionSummary).toBeNull();
  });

  it("handles summarizer failure gracefully", async () => {
    const buf = new ConversationBuffer();
    const summarizer = vi.fn().mockRejectedValue(new Error("API down"));
    buf.onNeedsSummary(summarizer);

    const base = new Date("2026-05-05T10:00:00Z").getTime();
    for (let i = 0; i < 13; i++) {
      buf.push(msg("user", `msg-${i}`, new Date(base + i * 1000).toISOString()));
    }

    // Wait for the promise to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(summarizer).toHaveBeenCalledTimes(1);
    expect(buf.sessionSummary).toBeNull(); // stays null on error
  });
});
