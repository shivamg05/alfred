/**
 * Tests for src/orchestrator/classifier.ts — classifyWithTimeout timeout logic,
 * extractJSON helper, Zod mode schema validation, classifyIntent error handling,
 * and generateContextualAck fallback behavior.
 *
 * Does NOT make real LLM calls — mocks llmClient.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, teardownTestDb } from "./setup.js";

// Mock llmClient before importing the module under test
const mockCreate = vi.fn();
vi.mock("../src/orchestrator/llm.js", () => ({
  llmClient: () => ({
    chat: { completions: { create: mockCreate } },
  }),
}));

import {
  classifyWithTimeout,
  classifyIntent,
  generateContextualAck,
  type ResponseMode,
} from "../src/orchestrator/classifier.js";

beforeEach(() => {
  setupTestDb();
  mockCreate.mockReset();
});

afterEach(() => {
  teardownTestDb();
  vi.restoreAllMocks();
});

function fakeResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

// ────────────────────────────────────────────────────────────────────
// extractJSON (private, tested indirectly via classifyIntent)
// ────────────────────────────────────────────────────────────────────

describe("extractJSON (via classifyIntent)", () => {
  it("parses clean JSON mode response", async () => {
    mockCreate.mockResolvedValue(fakeResponse('{"mode": "full"}'));
    const mode = await classifyIntent("what time is it?");
    expect(mode).toBe("full");
  });

  it("parses JSON with surrounding text", async () => {
    mockCreate.mockResolvedValue(
      fakeResponse('Based on the input, {"mode": "brief"} is best.'),
    );
    const mode = await classifyIntent("work has been crazy");
    expect(mode).toBe("brief");
  });

  it("parses JSON with markdown fences", async () => {
    mockCreate.mockResolvedValue(
      fakeResponse('```json\n{"mode": "silent"}\n```'),
    );
    const mode = await classifyIntent("lol");
    expect(mode).toBe("silent");
  });

  it("handles acknowledge mode", async () => {
    mockCreate.mockResolvedValue(fakeResponse('{"mode": "acknowledge"}'));
    const mode = await classifyIntent("remind me to call mom tomorrow");
    expect(mode).toBe("acknowledge");
  });
});

// ────────────────────────────────────────────────────────────────────
// Zod schema validation (invalid mode values)
// ────────────────────────────────────────────────────────────────────

describe("mode schema validation", () => {
  it("falls back to 'brief' for unknown mode value", async () => {
    mockCreate.mockResolvedValue(fakeResponse('{"mode": "verbose"}'));
    const mode = await classifyIntent("test message");
    expect(mode).toBe("brief");
  });

  it("falls back to 'brief' for missing mode field", async () => {
    mockCreate.mockResolvedValue(fakeResponse('{"intent": "question"}'));
    const mode = await classifyIntent("test message");
    expect(mode).toBe("brief");
  });

  it("falls back to 'brief' for non-object JSON", async () => {
    mockCreate.mockResolvedValue(fakeResponse('"brief"'));
    const mode = await classifyIntent("test");
    expect(mode).toBe("brief");
  });
});

// ────────────────────────────────────────────────────────────────────
// classifyIntent error handling
// ────────────────────────────────────────────────────────────────────

describe("classifyIntent error handling", () => {
  it("returns 'brief' when API call throws", async () => {
    mockCreate.mockRejectedValue(new Error("API down"));
    const mode = await classifyIntent("hello");
    expect(mode).toBe("brief");
  });

  it("returns 'brief' for completely invalid response", async () => {
    mockCreate.mockResolvedValue(fakeResponse("I cannot decide the mode"));
    const mode = await classifyIntent("hey");
    expect(mode).toBe("brief");
  });

  it("returns 'brief' for null content", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: null } }] });
    const mode = await classifyIntent("test");
    // null → default '{"mode":"brief"}' fallback
    expect(mode).toBe("brief");
  });

  it("returns 'brief' for empty choices", async () => {
    mockCreate.mockResolvedValue({ choices: [] });
    const mode = await classifyIntent("test");
    expect(mode).toBe("brief");
  });
});

// ────────────────────────────────────────────────────────────────────
// classifyWithTimeout — timeout behavior
// ────────────────────────────────────────────────────────────────────

describe("classifyWithTimeout", () => {
  it("returns mode from LLM when response is fast", async () => {
    mockCreate.mockResolvedValue(fakeResponse('{"mode": "full"}'));
    const mode = await classifyWithTimeout("what is this?", [], 5000);
    expect(mode).toBe("full");
  });

  it("returns 'brief' when LLM exceeds timeout", async () => {
    // Simulate a slow LLM call that takes 10 seconds
    mockCreate.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(fakeResponse('{"mode": "full"}')), 10_000)),
    );

    const mode = await classifyWithTimeout("what is this?", [], 50); // 50ms timeout
    expect(mode).toBe("brief");
  });

  it("uses default 5000ms timeout when not specified", async () => {
    mockCreate.mockResolvedValue(fakeResponse('{"mode": "silent"}'));
    const mode = await classifyWithTimeout("lol");
    expect(mode).toBe("silent");
  });

  it("passes recent messages to classifier", async () => {
    mockCreate.mockResolvedValue(fakeResponse('{"mode": "full"}'));

    await classifyWithTimeout("yes", [
      { role: "assistant", content: "want me to look that up?" },
    ]);

    const callArgs = mockCreate.mock.calls[0][0];
    const systemContent = callArgs.messages[0].content;
    expect(systemContent).toContain("want me to look that up?");
    expect(systemContent).toContain("RECENT CONVERSATION");
  });

  it("works with empty recent messages", async () => {
    mockCreate.mockResolvedValue(fakeResponse('{"mode": "brief"}'));
    const mode = await classifyWithTimeout("hey", []);
    expect(mode).toBe("brief");

    const callArgs = mockCreate.mock.calls[0][0];
    const systemContent = callArgs.messages[0].content;
    expect(systemContent).not.toContain("RECENT CONVERSATION");
  });
});

// ────────────────────────────────────────────────────────────────────
// classifyIntent — last-3-message cap
// ────────────────────────────────────────────────────────────────────

describe("classifyIntent last-3 message cap", () => {
  it("only includes last 3 messages even when more are provided", async () => {
    mockCreate.mockResolvedValue(fakeResponse('{"mode": "full"}'));

    await classifyIntent("follow up", [
      { role: "user", content: "msg-1-old" },
      { role: "assistant", content: "msg-2-old" },
      { role: "user", content: "msg-3-old" },
      { role: "assistant", content: "msg-4-old" },
      { role: "user", content: "msg-5-recent" },
      { role: "assistant", content: "msg-6-recent" },
      { role: "user", content: "msg-7-recent" },
    ]);

    const callArgs = mockCreate.mock.calls[0][0];
    const systemContent: string = callArgs.messages[0].content;

    // Should include last 3
    expect(systemContent).toContain("msg-5-recent");
    expect(systemContent).toContain("msg-6-recent");
    expect(systemContent).toContain("msg-7-recent");

    // Should NOT include older messages
    expect(systemContent).not.toContain("msg-1-old");
    expect(systemContent).not.toContain("msg-2-old");
    expect(systemContent).not.toContain("msg-3-old");
    expect(systemContent).not.toContain("msg-4-old");
  });

  it("works fine when fewer than 3 messages provided", async () => {
    mockCreate.mockResolvedValue(fakeResponse('{"mode": "brief"}'));

    await classifyIntent("test", [
      { role: "user", content: "only-one" },
    ]);

    const callArgs = mockCreate.mock.calls[0][0];
    const systemContent: string = callArgs.messages[0].content;
    expect(systemContent).toContain("only-one");
  });

  it("includes exactly 3 messages when exactly 3 provided", async () => {
    mockCreate.mockResolvedValue(fakeResponse('{"mode": "full"}'));

    await classifyIntent("yes", [
      { role: "assistant", content: "want to hear more?" },
      { role: "user", content: "yes tell me" },
      { role: "assistant", content: "ok so basically..." },
    ]);

    const callArgs = mockCreate.mock.calls[0][0];
    const systemContent: string = callArgs.messages[0].content;
    expect(systemContent).toContain("want to hear more?");
    expect(systemContent).toContain("yes tell me");
    expect(systemContent).toContain("ok so basically...");
  });
});

// ────────────────────────────────────────────────────────────────────
// generateContextualAck — fallback and formatting
// ────────────────────────────────────────────────────────────────────

describe("generateContextualAck", () => {
  it("returns LLM-generated ack when available", async () => {
    mockCreate.mockResolvedValue(fakeResponse("got it"));
    const ack = await generateContextualAck("remind me to call mom");
    expect(ack).toBe("got it");
  });

  it("returns fallback when LLM returns empty", async () => {
    mockCreate.mockResolvedValue(fakeResponse(""));
    const ack = await generateContextualAck("note this down");
    expect(["noted", "got it", "\u{1F44D}", "noted \u{1F44D}", "yep noted"]).toContain(ack);
  });

  it("returns fallback when LLM call throws", async () => {
    mockCreate.mockRejectedValue(new Error("API down"));
    const ack = await generateContextualAck("note this down");
    expect(["noted", "got it", "\u{1F44D}", "noted \u{1F44D}", "yep noted"]).toContain(ack);
  });

  it("returns fallback when response is null", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: null } }] });
    const ack = await generateContextualAck("test");
    expect(["noted", "got it", "\u{1F44D}", "noted \u{1F44D}", "yep noted"]).toContain(ack);
  });

  it("passes recent messages as context", async () => {
    mockCreate.mockResolvedValue(fakeResponse("on it"));
    await generateContextualAck("do that thing", [
      { role: "user", content: "I need to finish the project" },
      { role: "assistant", content: "you should start tonight" },
    ]);

    const callArgs = mockCreate.mock.calls[0][0];
    const systemContent = callArgs.messages[0].content;
    expect(systemContent).toContain("finish the project");
    expect(systemContent).toContain("start tonight");
  });
});
