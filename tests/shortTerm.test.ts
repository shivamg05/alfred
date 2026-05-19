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

  it("triggers summarizer when messages exceed INJECTION_CAP", async () => {
    const buf = new ConversationBuffer();
    const summarizer = vi.fn().mockResolvedValue("they talked about work stuff");
    buf.onNeedsSummary(summarizer);

    const base = new Date("2026-05-05T10:00:00Z").getTime();
    // Push 13 messages — 1 falls outside the 12-message injection window
    for (let i = 0; i < 13; i++) {
      buf.push(msg("user", `msg-${i}`, new Date(base + i * 1000).toISOString()));
    }

    // Wait for async summary to complete
    await vi.waitFor(() => {
      expect(buf.sessionSummary).toBe("they talked about work stuff");
    });

    expect(summarizer).toHaveBeenCalledTimes(1);
    // Called with (existingSummary, messages outside injection window)
    const existingSummary = summarizer.mock.calls[0][0];
    const foldedMsgs = summarizer.mock.calls[0][1];
    expect(existingSummary).toBeNull(); // first fold, no existing summary
    expect(foldedMsgs.length).toBe(1);
    expect(foldedMsgs[0].content).toBe("msg-0");
  });

  it("does NOT trigger summarizer when at or under INJECTION_CAP", () => {
    const buf = new ConversationBuffer();
    const summarizer = vi.fn().mockResolvedValue("summary");
    buf.onNeedsSummary(summarizer);

    const base = new Date("2026-05-05T10:00:00Z").getTime();
    // Push exactly 12 — all fit in injection window, nothing to summarize
    for (let i = 0; i < 12; i++) {
      buf.push(msg("user", `msg-${i}`, new Date(base + i * 1000).toISOString()));
    }

    expect(summarizer).not.toHaveBeenCalled();
    expect(buf.sessionSummary).toBeNull();
  });

  it("does NOT trigger summarizer if none registered", () => {
    const buf = new ConversationBuffer();
    const base = new Date("2026-05-05T10:00:00Z").getTime();
    // No crash when pushing past cap without a summarizer
    for (let i = 0; i < 25; i++) {
      buf.push(msg("user", `msg-${i}`, new Date(base + i * 1000).toISOString()));
    }
    expect(buf.sessionSummary).toBeNull();
  });

  it("summarizes gap between injection window and buffer (messages 12-19)", async () => {
    const buf = new ConversationBuffer();
    const summarizer = vi.fn().mockResolvedValue("covered the gap messages");
    buf.onNeedsSummary(summarizer);

    const base = new Date("2026-05-05T10:00:00Z").getTime();
    // Push 20 messages — buffer is full, injection window is last 12
    // Messages 0-7 should be folded into summary (8 messages outside injection window)
    for (let i = 0; i < 20; i++) {
      buf.push(msg("user", `msg-${i}`, new Date(base + i * 1000).toISOString()));
    }

    await vi.waitFor(() => {
      expect(buf.sessionSummary).toBe("covered the gap messages");
    });

    // getForPrompt returns last 12 (msg-8 through msg-19)
    const forPrompt = buf.getForPrompt();
    expect(forPrompt.length).toBe(12);
    expect(forPrompt[0].content).toBe("msg-8");

    // getRecent returns all 20 (for extraction)
    expect(buf.getRecent().length).toBe(20);
  });

  it("clears sessionSummary on 4h gap reset", async () => {
    const buf = new ConversationBuffer();
    const summarizer = vi.fn().mockResolvedValue("old summary");
    buf.onNeedsSummary(summarizer);

    const base = new Date("2026-05-05T10:00:00Z").getTime();
    // Push 15 to trigger summary (3 outside injection window)
    for (let i = 0; i < 15; i++) {
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
    // Push 15 to trigger summary
    for (let i = 0; i < 15; i++) {
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
    // Push 13 to trigger fold
    for (let i = 0; i < 13; i++) {
      buf.push(msg("user", `msg-${i}`, new Date(base + i * 1000).toISOString()));
    }

    // Wait for the promise to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(summarizer).toHaveBeenCalledTimes(1);
    expect(buf.sessionSummary).toBeNull(); // stays null on error
  });

  it("folds incrementally — passes existing summary to subsequent folds", async () => {
    const buf = new ConversationBuffer();
    let callCount = 0;
    const summarizer = vi.fn().mockImplementation(async (existing: string | null) => {
      callCount++;
      if (callCount === 1) return "talked about morning routine";
      return `${existing} | then discussed evening plans`;
    });
    buf.onNeedsSummary(summarizer);

    const base = new Date("2026-05-05T10:00:00Z").getTime();
    // Push 13 to trigger first fold (msg-0 outside injection window)
    for (let i = 0; i < 13; i++) {
      buf.push(msg("user", `msg-${i}`, new Date(base + i * 1000).toISOString()));
    }

    await vi.waitFor(() => {
      expect(buf.sessionSummary).toBe("talked about morning routine");
    });

    // Push 1 more — msg-1 now falls outside injection window, triggers second fold
    buf.push(msg("user", "msg-13", new Date(base + 13 * 1000).toISOString()));

    await vi.waitFor(() => {
      expect(buf.sessionSummary).toContain("then discussed evening plans");
    });

    expect(summarizer).toHaveBeenCalledTimes(2);
    // Second call should have received the existing summary
    expect(summarizer.mock.calls[1][0]).toBe("talked about morning routine");
    expect(summarizer.mock.calls[1][1].length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// Decision log
// ────────────────────────────────────────────────────────────────────

describe("decision log", () => {
  it("starts with null decisionLog", () => {
    const buf = new ConversationBuffer();
    expect(buf.decisionLog).toBeNull();
  });

  it("updates decisionLog when updateDecisionLog is called", async () => {
    const buf = new ConversationBuffer();
    const updater = vi.fn().mockResolvedValue("Discussing weekend plans. User seems excited.");
    buf.onUpdateDecisionLog(updater);

    buf.updateDecisionLog("wanna do something this weekend?", "hell yeah what are you thinking");

    await vi.waitFor(() => {
      expect(buf.decisionLog).toBe("Discussing weekend plans. User seems excited.");
    });

    expect(updater).toHaveBeenCalledWith(
      null,
      "wanna do something this weekend?",
      "hell yeah what are you thinking",
    );
  });

  it("passes current log to updater on subsequent calls", async () => {
    const buf = new ConversationBuffer();
    let callCount = 0;
    const updater = vi.fn().mockImplementation(async (currentLog) => {
      callCount++;
      return callCount === 1
        ? "Topic: weekend plans."
        : `${currentLog} Decided on hiking Saturday.`;
    });
    buf.onUpdateDecisionLog(updater);

    // First turn
    buf.updateDecisionLog("wanna hike?", "down, saturday?");
    await vi.waitFor(() => {
      expect(buf.decisionLog).toBe("Topic: weekend plans.");
    });

    // Second turn — should receive previous log
    buf.updateDecisionLog("yeah saturday works", "bet, i'll look up trails");
    await vi.waitFor(() => {
      expect(buf.decisionLog).toContain("Decided on hiking Saturday");
    });

    expect(updater.mock.calls[1][0]).toBe("Topic: weekend plans.");
  });

  it("does nothing if no updater registered", () => {
    const buf = new ConversationBuffer();
    // Should not throw
    buf.updateDecisionLog("test", "test reply");
    expect(buf.decisionLog).toBeNull();
  });

  it("clears decisionLog on 4h gap reset", async () => {
    const buf = new ConversationBuffer();
    const updater = vi.fn().mockResolvedValue("some state");
    buf.onUpdateDecisionLog(updater);

    buf.push(msg("user", "hey", "2026-05-05T10:00:00Z"));
    buf.updateDecisionLog("hey", "what's up");
    await vi.waitFor(() => {
      expect(buf.decisionLog).toBe("some state");
    });

    // 5 hours later — triggers session reset
    buf.push(msg("user", "new session", "2026-05-05T15:00:01Z"));
    expect(buf.decisionLog).toBeNull();
  });

  it("clears decisionLog on seed", async () => {
    const buf = new ConversationBuffer();
    const updater = vi.fn().mockResolvedValue("old state");
    buf.onUpdateDecisionLog(updater);

    buf.updateDecisionLog("msg", "reply");
    await vi.waitFor(() => {
      expect(buf.decisionLog).toBe("old state");
    });

    buf.seed([msg("user", "fresh", "2026-05-06T10:00:00Z")]);
    expect(buf.decisionLog).toBeNull();
  });

  it("handles updater failure gracefully", async () => {
    const buf = new ConversationBuffer();
    const updater = vi.fn().mockRejectedValue(new Error("LLM down"));
    buf.onUpdateDecisionLog(updater);

    buf.updateDecisionLog("test", "test reply");

    await new Promise((r) => setTimeout(r, 50));

    expect(updater).toHaveBeenCalledTimes(1);
    expect(buf.decisionLog).toBeNull(); // stays null on error
  });

  it("prevents overlapping update calls", async () => {
    const buf = new ConversationBuffer();
    let resolveFirst: (v: string) => void;
    const firstCall = new Promise<string>((r) => { resolveFirst = r; });
    const updater = vi.fn()
      .mockReturnValueOnce(firstCall)
      .mockResolvedValueOnce("second");
    buf.onUpdateDecisionLog(updater);

    // Fire first update (will hang)
    buf.updateDecisionLog("msg1", "reply1");
    // Fire second immediately — should be skipped because first is in flight
    buf.updateDecisionLog("msg2", "reply2");

    expect(updater).toHaveBeenCalledTimes(1);

    // Resolve first
    resolveFirst!("first result");
    await vi.waitFor(() => {
      expect(buf.decisionLog).toBe("first result");
    });
  });
});
