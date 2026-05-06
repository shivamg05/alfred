/**
 * Tests for src/memory/shortTerm.ts — ConversationBuffer behavior:
 * capacity, session gap reset, seed, and recent retrieval.
 */

import { describe, it, expect } from "vitest";
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
