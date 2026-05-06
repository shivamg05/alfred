/**
 * Tests for src/memory/consolidation.ts — L0 expiration, L1 promotion.
 * Mocks LLM calls and ChromaDB; tests the SQLite state transitions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, teardownTestDb, getTestDb } from "./setup.js";

// Mock external deps
vi.mock("../src/orchestrator/llm.js", () => ({
  makeOpenAIClient: vi.fn(() => ({
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: '{"should_consolidate": true, "text": "User patterns X regularly"}' } }],
        }),
      },
    },
  })),
}));

vi.mock("../src/memory/vectors.js", () => ({
  querySimilarFacts: vi.fn().mockResolvedValue([]),
  upsertFact: vi.fn().mockResolvedValue("chroma-id-test"),
}));

import {
  insertFact,
  getFactById,
  getExpiredLevel0Facts,
  setProactiveAfter,
  markNudgeFired,
} from "../src/memory/facts.js";
import { consolidateExpiredLevel0 } from "../src/memory/consolidation.js";

const DOC_DATE = "2026-05-05T12:00:00Z";
const PAST = new Date(Date.now() - 86400000).toISOString();

beforeEach(() => setupTestDb());
afterEach(() => {
  teardownTestDb();
  vi.restoreAllMocks();
});

describe("consolidateExpiredLevel0", () => {
  it("marks singleton expired facts as forgotten", async () => {
    const id = insertFact({
      text: "User was tired yesterday",
      is_static: false,
      document_date: DOC_DATE,
      abstraction_level: 0,
      forget_after: PAST,
    });

    await consolidateExpiredLevel0();
    expect(getFactById(id)!.is_forgotten).toBeTruthy();
  });

  it("does not process facts with unfired nudges", async () => {
    const id = insertFact({
      text: "User intends to call advisor",
      is_static: false,
      document_date: DOC_DATE,
      abstraction_level: 0,
      forget_after: PAST,
    });
    // Set nudge that hasn't fired yet
    setProactiveAfter(id, new Date(Date.now() + 3600000).toISOString());

    await consolidateExpiredLevel0();
    // Fact should still be alive
    expect(getFactById(id)!.is_forgotten).toBeFalsy();
  });

  it("processes facts with FIRED nudges normally", async () => {
    const id = insertFact({
      text: "User wanted to call advisor (done)",
      is_static: false,
      document_date: DOC_DATE,
      abstraction_level: 0,
      forget_after: PAST,
    });
    setProactiveAfter(id, PAST);
    markNudgeFired(id);

    await consolidateExpiredLevel0();
    expect(getFactById(id)!.is_forgotten).toBeTruthy();
  });

  it("skips when no expired facts exist", async () => {
    // Insert a fact that hasn't expired yet
    insertFact({
      text: "Fresh fact",
      is_static: false,
      document_date: DOC_DATE,
      abstraction_level: 0,
      forget_after: new Date(Date.now() + 86400000).toISOString(),
    });

    // Should return without error
    await consolidateExpiredLevel0();
  });

  it("does not touch L1 or L2 facts", async () => {
    const l1 = insertFact({
      text: "User patterns running",
      is_static: false,
      document_date: DOC_DATE,
      abstraction_level: 1,
    });

    await consolidateExpiredLevel0();
    expect(getFactById(l1)!.is_forgotten).toBeFalsy();
  });
});
