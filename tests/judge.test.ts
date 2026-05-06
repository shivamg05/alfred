/**
 * Tests for src/proactive/judge.ts — JSON fence stripping, score parsing,
 * clamping, and error handling.
 *
 * Does NOT make real LLM calls — mocks makeOpenAIClient.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, teardownTestDb } from "./setup.js";

// Mock the LLM client before importing the module under test
vi.mock("../src/orchestrator/llm.js", () => ({
  makeOpenAIClient: vi.fn(),
}));

import { judgeProactiveMessage, JUDGE_THRESHOLD } from "../src/proactive/judge.js";
import { makeOpenAIClient } from "../src/orchestrator/llm.js";

const mockCreate = vi.fn();
const mockedMakeOpenAIClient = vi.mocked(makeOpenAIClient);

beforeEach(() => {
  setupTestDb();
  mockCreate.mockReset();
  mockedMakeOpenAIClient.mockReturnValue({
    chat: { completions: { create: mockCreate } },
  } as any);
});

afterEach(() => {
  teardownTestDb();
});

function fakeResponse(content: string) {
  return {
    choices: [{ message: { content } }],
  };
}

describe("judgeProactiveMessage", () => {
  it("parses clean JSON response", async () => {
    mockCreate.mockResolvedValue(fakeResponse('{"score": 85, "reason": "relevant"}'));

    const result = await judgeProactiveMessage("test message", ["fact1"]);
    expect(result.score).toBe(85);
    expect(result.reason).toBe("relevant");
  });

  it("strips markdown json fences (the root cause bug)", async () => {
    mockCreate.mockResolvedValue(
      fakeResponse('```json\n{"score": 73, "reason": "timely and relevant"}\n```'),
    );

    const result = await judgeProactiveMessage("test message", ["fact1"]);
    expect(result.score).toBe(73);
    expect(result.reason).toBe("timely and relevant");
  });

  it("strips fences with no language tag", async () => {
    mockCreate.mockResolvedValue(
      fakeResponse('```\n{"score": 60, "reason": "meh"}\n```'),
    );

    const result = await judgeProactiveMessage("test message", []);
    expect(result.score).toBe(60);
    expect(result.reason).toBe("meh");
  });

  it("clamps score to 0-100 range", async () => {
    mockCreate.mockResolvedValue(fakeResponse('{"score": 150, "reason": "too high"}'));
    const high = await judgeProactiveMessage("msg", []);
    expect(high.score).toBe(100);

    mockCreate.mockResolvedValue(fakeResponse('{"score": -20, "reason": "too low"}'));
    const low = await judgeProactiveMessage("msg", []);
    expect(low.score).toBe(0);
  });

  it("returns score=0 when score field is missing", async () => {
    mockCreate.mockResolvedValue(fakeResponse('{"reason": "no score"}'));
    const result = await judgeProactiveMessage("msg", []);
    expect(result.score).toBe(0);
  });

  it("returns score=0 when score is not a number", async () => {
    mockCreate.mockResolvedValue(fakeResponse('{"score": "high", "reason": "string score"}'));
    const result = await judgeProactiveMessage("msg", []);
    expect(result.score).toBe(0);
  });

  it("returns parse_error on completely invalid JSON", async () => {
    mockCreate.mockResolvedValue(fakeResponse("This is not JSON at all"));
    const result = await judgeProactiveMessage("msg", []);
    expect(result.score).toBe(0);
    expect(result.reason).toBe("parse_error");
  });

  it("returns llm_error when API call throws", async () => {
    mockCreate.mockRejectedValue(new Error("API down"));
    const result = await judgeProactiveMessage("msg", []);
    expect(result.score).toBe(0);
    expect(result.reason).toBe("llm_error");
  });

  it("handles null response content", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: null } }] });
    const result = await judgeProactiveMessage("msg", []);
    expect(result.score).toBe(0);
    expect(result.reason).toBe("no_response");
  });

  it("handles empty choices array", async () => {
    mockCreate.mockResolvedValue({ choices: [] });
    const result = await judgeProactiveMessage("msg", []);
    expect(result.score).toBe(0);
  });

  it("passes context facts correctly", async () => {
    mockCreate.mockResolvedValue(fakeResponse('{"score": 70, "reason": "ok"}'));

    await judgeProactiveMessage("hey check this out", ["User likes AI", "User is a student"]);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages[1].content).toContain("User likes AI");
    expect(callArgs.messages[1].content).toContain("User is a student");
  });

  it("handles empty context facts", async () => {
    mockCreate.mockResolvedValue(fakeResponse('{"score": 50, "reason": "vague"}'));

    await judgeProactiveMessage("test", []);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages[1].content).toContain("(no context)");
  });
});

describe("JUDGE_THRESHOLD", () => {
  it("is set to 70", () => {
    expect(JUDGE_THRESHOLD).toBe(70);
  });
});
