/**
 * Tests for src/orchestrator/response.ts — sendBubbles behavior:
 * splitting, cleaning, markdown stripping, max 2 bubbles, trailing period removal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, teardownTestDb } from "./setup.js";

// Mock the imessage-kit SDK
const mockSend = vi.fn().mockResolvedValue(undefined);
const mockSdk = { send: mockSend } as any;

import { sendBubbles } from "../src/orchestrator/response.js";

beforeEach(() => {
  setupTestDb();
  mockSend.mockClear();
});
afterEach(() => teardownTestDb());

describe("sendBubbles", () => {
  it("sends a single bubble for text without [SPLIT]", async () => {
    await sendBubbles(mockSdk, "hey whats up");
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].text).toBe("hey whats up");
  });

  it("splits on [SPLIT] into multiple bubbles", async () => {
    await sendBubbles(mockSdk, "first part[SPLIT]second part");
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[0][0].text).toBe("first part");
    expect(mockSend.mock.calls[1][0].text).toBe("second part");
  });

  it("caps at 2 bubbles max", async () => {
    await sendBubbles(mockSdk, "one[SPLIT]two[SPLIT]three[SPLIT]four");
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("strips trailing periods (but not ellipsis)", async () => {
    await sendBubbles(mockSdk, "this is a sentence.");
    expect(mockSend.mock.calls[0][0].text).toBe("this is a sentence");

    mockSend.mockClear();
    await sendBubbles(mockSdk, "thinking about it...");
    expect(mockSend.mock.calls[0][0].text).toBe("thinking about it...");
  });

  it("strips markdown bold, italic, inline code", async () => {
    await sendBubbles(mockSdk, "this is **bold** and *italic* and `code`");
    expect(mockSend.mock.calls[0][0].text).toBe("this is bold and italic and code");
  });

  it("strips underline-style markdown", async () => {
    await sendBubbles(mockSdk, "__underline bold__ and _underline italic_");
    expect(mockSend.mock.calls[0][0].text).toBe("underline bold and underline italic");
  });

  it("filters empty bubbles after splitting", async () => {
    await sendBubbles(mockSdk, "[SPLIT]   [SPLIT]actual content");
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].text).toBe("actual content");
  });

  it("sends to the configured USER_PHONE", async () => {
    await sendBubbles(mockSdk, "test");
    expect(mockSend.mock.calls[0][0].to).toBe("+15559876543"); // from testConfig
  });
});
