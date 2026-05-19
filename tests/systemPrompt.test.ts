/**
 * Tests for src/tone/systemPrompt.ts — prompt construction:
 * mode-specific instructions, memory section assembly, timestamp injection,
 * Todoist section, conversation history formatting.
 *
 * Does NOT make real LLM calls — tests pure string construction.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, teardownTestDb } from "./setup.js";

import { buildSystemPrompt } from "../src/tone/systemPrompt.js";
import type { RetrievedContext } from "../src/memory/retrieval.js";
import type { BufferMessage } from "../src/memory/shortTerm.js";

beforeEach(() => setupTestDb());
afterEach(() => teardownTestDb());

function makeContext(overrides: Partial<RetrievedContext> = {}): RetrievedContext {
  return {
    identity: [],
    bedrock: [],
    retrieved: [],
    ...overrides,
  };
}

function makeMessages(...msgs: Array<[string, string]>): BufferMessage[] {
  return msgs.map(([role, content], i) => ({
    role: role as "user" | "assistant",
    content,
    timestamp: new Date(Date.now() + i * 1000).toISOString(),
  }));
}

// ────────────────────────────────────────────────────────────────────
// Basic prompt structure
// ────────────────────────────────────────────────────────────────────

describe("prompt structure", () => {
  it("includes Alfred personality header", () => {
    const prompt = buildSystemPrompt(makeContext(), []);
    expect(prompt).toContain("you are Alfred");
    expect(prompt).toContain("imessage");
  });

  it("includes NOW timestamp in user's timezone", () => {
    const prompt = buildSystemPrompt(makeContext(), []);
    // testConfig.USER_TIMEZONE = "America/New_York"
    expect(prompt).toContain("NOW:");
    // Should contain a formatted date string
    expect(prompt).toMatch(/NOW:.*\d{4}/);
  });

  it("includes formatting rules", () => {
    const prompt = buildSystemPrompt(makeContext(), []);
    expect(prompt).toContain("FORMATTING");
    expect(prompt).toContain("[SPLIT]");
    expect(prompt).toContain("lowercase");
  });

  it("includes personality traits", () => {
    const prompt = buildSystemPrompt(makeContext(), []);
    expect(prompt).toContain("OPINIONS");
    expect(prompt).toContain("brevity");
    expect(prompt).toContain("friend");
  });
});

// ────────────────────────────────────────────────────────────────────
// Mode-specific instructions
// ────────────────────────────────────────────────────────────────────

describe("mode-specific instructions", () => {
  it("acknowledge mode: short confirmation only", () => {
    const prompt = buildSystemPrompt(makeContext(), [], "", "acknowledge");
    expect(prompt).toContain("RESPONSE LENGTH");
    expect(prompt).toContain("single word");
    expect(prompt).toContain("no opinions");
  });

  it("brief mode: one sentence, 15 words", () => {
    const prompt = buildSystemPrompt(makeContext(), [], "", "brief");
    expect(prompt).toContain("RESPONSE LENGTH");
    expect(prompt).toContain("one sentence");
    expect(prompt).toContain("15 words");
  });

  it("full mode: 1-2 bubbles, 20 words each", () => {
    const prompt = buildSystemPrompt(makeContext(), [], "", "full");
    expect(prompt).toContain("RESPONSE LENGTH");
    expect(prompt).toContain("1-2 bubbles");
    expect(prompt).toContain("20 words");
  });

  it("silent mode: no response length instruction", () => {
    const prompt = buildSystemPrompt(makeContext(), [], "", "silent");
    expect(prompt).not.toContain("RESPONSE LENGTH");
  });

  it("default mode is full", () => {
    const promptDefault = buildSystemPrompt(makeContext(), []);
    const promptFull = buildSystemPrompt(makeContext(), [], "", "full");
    // Both should contain the full mode instruction
    expect(promptDefault).toContain("1-2 bubbles");
    expect(promptFull).toContain("1-2 bubbles");
  });
});

// ────────────────────────────────────────────────────────────────────
// Memory sections
// ────────────────────────────────────────────────────────────────────

describe("memory sections", () => {
  it("includes identity facts when present", () => {
    const ctx = makeContext({ identity: ["User is a CS student", "User lives in NYC"] });
    const prompt = buildSystemPrompt(ctx, []);
    expect(prompt).toContain("CORE IDENTITY");
    expect(prompt).toContain("- User is a CS student");
    expect(prompt).toContain("- User lives in NYC");
  });

  it("omits identity section when empty", () => {
    const prompt = buildSystemPrompt(makeContext({ identity: [] }), []);
    expect(prompt).not.toContain("CORE IDENTITY");
  });

  it("includes bedrock patterns when present", () => {
    const ctx = makeContext({ bedrock: ["User runs 3x per week", "User reads before bed"] });
    const prompt = buildSystemPrompt(ctx, []);
    expect(prompt).toContain("FOUNDATIONAL PATTERNS");
    expect(prompt).toContain("- User runs 3x per week");
  });

  it("omits bedrock section when empty", () => {
    const prompt = buildSystemPrompt(makeContext({ bedrock: [] }), []);
    expect(prompt).not.toContain("FOUNDATIONAL PATTERNS");
  });

  it("includes retrieved facts when present", () => {
    const ctx = makeContext({ retrieved: ["User mentioned wanting to visit Japan"] });
    const prompt = buildSystemPrompt(ctx, []);
    expect(prompt).toContain("RELEVANT MEMORY");
    expect(prompt).toContain("- User mentioned wanting to visit Japan");
  });

  it("omits retrieved section when empty", () => {
    const prompt = buildSystemPrompt(makeContext({ retrieved: [] }), []);
    expect(prompt).not.toContain("RELEVANT MEMORY");
  });

  it("includes all three memory sections together", () => {
    const ctx = makeContext({
      identity: ["Identity fact"],
      bedrock: ["Bedrock fact"],
      retrieved: ["Retrieved fact"],
    });
    const prompt = buildSystemPrompt(ctx, []);
    expect(prompt).toContain("CORE IDENTITY");
    expect(prompt).toContain("FOUNDATIONAL PATTERNS");
    expect(prompt).toContain("RELEVANT MEMORY");
  });

  it("omits all memory sections when context is empty", () => {
    const prompt = buildSystemPrompt(makeContext(), []);
    expect(prompt).not.toContain("CORE IDENTITY");
    expect(prompt).not.toContain("FOUNDATIONAL PATTERNS");
    expect(prompt).not.toContain("RELEVANT MEMORY");
  });
});

// ────────────────────────────────────────────────────────────────────
// Conversation history
// ────────────────────────────────────────────────────────────────────

describe("conversation history", () => {
  it("formats recent messages with role labels", () => {
    const msgs = makeMessages(["user", "hey whats up"], ["assistant", "not much you"]);
    const prompt = buildSystemPrompt(makeContext(), msgs);
    expect(prompt).toContain("[user]: hey whats up");
    expect(prompt).toContain("[alfred]: not much you");
  });

  it("shows '(start of conversation)' when no messages", () => {
    const prompt = buildSystemPrompt(makeContext(), []);
    expect(prompt).toContain("(start of conversation)");
  });

  it("includes RECENT CONVERSATION header", () => {
    const msgs = makeMessages(["user", "test"]);
    const prompt = buildSystemPrompt(makeContext(), msgs);
    expect(prompt).toContain("RECENT CONVERSATION");
  });
});

// ────────────────────────────────────────────────────────────────────
// Session summary
// ────────────────────────────────────────────────────────────────────

describe("session summary", () => {
  it("includes summary when provided", () => {
    const msgs = makeMessages(["user", "so what do you think"]);
    const prompt = buildSystemPrompt(makeContext(), msgs, "", "full", "They discussed work stress and a plan to take Friday off");
    expect(prompt).toContain("earlier in this conversation");
    expect(prompt).toContain("discussed work stress");
    expect(prompt).toContain("take Friday off");
  });

  it("omits summary block when null", () => {
    const msgs = makeMessages(["user", "hey"]);
    const prompt = buildSystemPrompt(makeContext(), msgs, "", "full", null);
    expect(prompt).not.toContain("earlier in this conversation");
  });

  it("summary appears before recent messages", () => {
    const msgs = makeMessages(["user", "continue"]);
    const prompt = buildSystemPrompt(makeContext(), msgs, "", "full", "Old context here");
    const summaryIdx = prompt.indexOf("earlier in this conversation");
    const msgIdx = prompt.indexOf("[user]: continue");
    expect(summaryIdx).toBeLessThan(msgIdx);
  });
});

// ────────────────────────────────────────────────────────────────────
// Decision log
// ────────────────────────────────────────────────────────────────────

describe("decision log", () => {
  it("includes decision log when provided", () => {
    const msgs = makeMessages(["user", "so saturday?"]);
    const prompt = buildSystemPrompt(makeContext(), msgs, "", "full", null, "Discussing weekend plans. Considering hiking Saturday.");
    expect(prompt).toContain("SESSION STATE");
    expect(prompt).toContain("Discussing weekend plans");
    expect(prompt).toContain("hiking Saturday");
  });

  it("omits decision log when null", () => {
    const msgs = makeMessages(["user", "hey"]);
    const prompt = buildSystemPrompt(makeContext(), msgs, "", "full", null, null);
    expect(prompt).not.toContain("SESSION STATE");
  });

  it("decision log appears before RECENT CONVERSATION", () => {
    const msgs = makeMessages(["user", "what time?"]);
    const prompt = buildSystemPrompt(makeContext(), msgs, "", "full", null, "Planning a meetup.");
    const logIdx = prompt.indexOf("SESSION STATE");
    const convIdx = prompt.indexOf("RECENT CONVERSATION");
    expect(logIdx).toBeLessThan(convIdx);
  });

  it("decision log appears after memory sections", () => {
    const ctx = makeContext({ identity: ["User is a student"] });
    const msgs = makeMessages(["user", "test"]);
    const prompt = buildSystemPrompt(ctx, msgs, "", "full", null, "Some session state.");
    const memIdx = prompt.indexOf("CORE IDENTITY");
    const logIdx = prompt.indexOf("SESSION STATE");
    expect(memIdx).toBeLessThan(logIdx);
  });

  it("both session summary and decision log can coexist", () => {
    const msgs = makeMessages(["user", "continue"]);
    const prompt = buildSystemPrompt(makeContext(), msgs, "", "full", "Earlier they talked about X.", "Active topic: Y. User seems tired.");
    expect(prompt).toContain("earlier in this conversation");
    expect(prompt).toContain("SESSION STATE");
    expect(prompt).toContain("Active topic: Y");
  });
});

// ────────────────────────────────────────────────────────────────────
// Todoist section
// ────────────────────────────────────────────────────────────────────

describe("Todoist section", () => {
  it("includes Todoist tasks when provided", () => {
    const tasks = "- Buy groceries (due today)\n- Finish homework (due tomorrow)";
    const prompt = buildSystemPrompt(makeContext(), [], tasks);
    expect(prompt).toContain("OPEN TODOIST TASKS");
    expect(prompt).toContain("Buy groceries");
    expect(prompt).toContain("Finish homework");
  });

  it("omits Todoist section when empty string", () => {
    const prompt = buildSystemPrompt(makeContext(), [], "");
    expect(prompt).not.toContain("TODOIST");
  });

  it("omits Todoist section when not provided", () => {
    const prompt = buildSystemPrompt(makeContext(), []);
    expect(prompt).not.toContain("TODOIST");
  });
});

// ────────────────────────────────────────────────────────────────────
// Tool descriptions
// ────────────────────────────────────────────────────────────────────

describe("tool descriptions in prompt", () => {
  it("mentions search_web tool", () => {
    const prompt = buildSystemPrompt(makeContext(), []);
    expect(prompt).toContain("search_web");
  });

  it("mentions todoist tools", () => {
    const prompt = buildSystemPrompt(makeContext(), []);
    expect(prompt).toContain("todoist_list_tasks");
    expect(prompt).toContain("todoist_close_task");
    expect(prompt).toContain("todoist_create_task");
  });

  it("mentions scrape_url tool", () => {
    const prompt = buildSystemPrompt(makeContext(), []);
    expect(prompt).toContain("scrape_url");
  });
});
