/**
 * Tests for src/tools/registry.ts — getTools config-dependent tool availability,
 * executeTool dispatch routing, and unknown tool handling.
 *
 * Does NOT make real API calls — mocks web and todoist tool executors.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, teardownTestDb } from "./setup.js";
import { testConfig } from "./setup.js";

// Mock tool executors
vi.mock("../src/tools/web.js", () => ({
  executeWebTool: vi.fn().mockResolvedValue("web result"),
}));

vi.mock("../src/tools/todoist.js", () => ({
  executeTodoistTool: vi.fn().mockResolvedValue("todoist result"),
}));

import { getTools, executeTool } from "../src/tools/registry.js";
import { executeWebTool } from "../src/tools/web.js";
import { executeTodoistTool } from "../src/tools/todoist.js";

const mockedExecuteWebTool = vi.mocked(executeWebTool);
const mockedExecuteTodoistTool = vi.mocked(executeTodoistTool);

beforeEach(() => {
  setupTestDb();
  vi.clearAllMocks();
});

afterEach(() => {
  teardownTestDb();
});

// ────────────────────────────────────────────────────────────────────
// getTools — config-dependent availability
// ────────────────────────────────────────────────────────────────────

describe("getTools", () => {
  it("returns empty array when no API keys are configured", () => {
    // testConfig has FIRECRAWL_API_KEY = undefined, TODOIST_API_TOKEN = undefined
    testConfig.FIRECRAWL_API_KEY = undefined;
    testConfig.TODOIST_API_TOKEN = undefined;
    const tools = getTools();
    expect(tools).toEqual([]);
  });

  it("returns web tools when FIRECRAWL_API_KEY is set", () => {
    testConfig.FIRECRAWL_API_KEY = "fc-test-key";
    testConfig.TODOIST_API_TOKEN = undefined;

    const tools = getTools();
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("search_web");
    expect(names).toContain("scrape_url");
    expect(names).not.toContain("todoist_list_tasks");
  });

  it("returns Todoist tools when TODOIST_API_TOKEN is set", () => {
    testConfig.FIRECRAWL_API_KEY = undefined;
    testConfig.TODOIST_API_TOKEN = "todoist-test-token";

    const tools = getTools();
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("todoist_list_tasks");
    expect(names).toContain("todoist_close_task");
    expect(names).toContain("todoist_update_task");
    expect(names).toContain("todoist_create_task");
    expect(names).not.toContain("search_web");
  });

  it("returns all tools when both keys are set", () => {
    testConfig.FIRECRAWL_API_KEY = "fc-test-key";
    testConfig.TODOIST_API_TOKEN = "todoist-test-token";

    const tools = getTools();
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("search_web");
    expect(names).toContain("scrape_url");
    expect(names).toContain("todoist_list_tasks");
    expect(names).toContain("todoist_close_task");
    expect(names).toContain("todoist_update_task");
    expect(names).toContain("todoist_create_task");
    expect(tools.length).toBe(6); // 2 web + 4 todoist
  });

  it("tool definitions have correct structure", () => {
    testConfig.FIRECRAWL_API_KEY = "fc-test-key";
    testConfig.TODOIST_API_TOKEN = "todoist-test-token";

    const tools = getTools();
    for (const tool of tools) {
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters).toBeDefined();
      expect(tool.function.parameters.type).toBe("object");
    }
  });

  it("search_web requires query parameter", () => {
    testConfig.FIRECRAWL_API_KEY = "fc-test-key";
    const tools = getTools();
    const searchWeb = tools.find((t) => t.function.name === "search_web");
    expect(searchWeb!.function.parameters.required).toContain("query");
  });

  it("scrape_url requires url parameter", () => {
    testConfig.FIRECRAWL_API_KEY = "fc-test-key";
    const tools = getTools();
    const scrapeUrl = tools.find((t) => t.function.name === "scrape_url");
    expect(scrapeUrl!.function.parameters.required).toContain("url");
  });

  it("todoist_close_task requires task_id and task_name", () => {
    testConfig.TODOIST_API_TOKEN = "todoist-test-token";
    const tools = getTools();
    const closeTool = tools.find((t) => t.function.name === "todoist_close_task");
    expect(closeTool!.function.parameters.required).toContain("task_id");
    expect(closeTool!.function.parameters.required).toContain("task_name");
  });

  it("todoist_create_task requires content parameter", () => {
    testConfig.TODOIST_API_TOKEN = "todoist-test-token";
    const tools = getTools();
    const createTool = tools.find((t) => t.function.name === "todoist_create_task");
    expect(createTool!.function.parameters.required).toContain("content");
  });
});

// ────────────────────────────────────────────────────────────────────
// executeTool — dispatch routing
// ────────────────────────────────────────────────────────────────────

describe("executeTool dispatch", () => {
  afterEach(() => {
    // Reset config to defaults
    testConfig.FIRECRAWL_API_KEY = undefined;
    testConfig.TODOIST_API_TOKEN = undefined;
  });

  it("routes search_web to executeWebTool", async () => {
    const result = await executeTool("search_web", { query: "weather today" });
    expect(mockedExecuteWebTool).toHaveBeenCalledWith("search_web", { query: "weather today" });
    expect(result).toBe("web result");
  });

  it("routes scrape_url to executeWebTool", async () => {
    const result = await executeTool("scrape_url", { url: "https://example.com" });
    expect(mockedExecuteWebTool).toHaveBeenCalledWith("scrape_url", { url: "https://example.com" });
    expect(result).toBe("web result");
  });

  it("routes todoist_list_tasks to executeTodoistTool", async () => {
    const result = await executeTool("todoist_list_tasks", { filter: "today" });
    expect(mockedExecuteTodoistTool).toHaveBeenCalledWith("todoist_list_tasks", { filter: "today" });
    expect(result).toBe("todoist result");
  });

  it("routes todoist_close_task to executeTodoistTool", async () => {
    const result = await executeTool("todoist_close_task", {
      task_id: "123",
      task_name: "Buy milk",
    });
    expect(mockedExecuteTodoistTool).toHaveBeenCalledWith("todoist_close_task", {
      task_id: "123",
      task_name: "Buy milk",
    });
    expect(result).toBe("todoist result");
  });

  it("routes todoist_update_task to executeTodoistTool", async () => {
    const result = await executeTool("todoist_update_task", {
      task_id: "456",
      task_name: "Call mom",
      due_string: "tomorrow",
    });
    expect(mockedExecuteTodoistTool).toHaveBeenCalledWith("todoist_update_task", {
      task_id: "456",
      task_name: "Call mom",
      due_string: "tomorrow",
    });
    expect(result).toBe("todoist result");
  });

  it("routes todoist_create_task to executeTodoistTool", async () => {
    const result = await executeTool("todoist_create_task", {
      content: "New task",
      due_string: "next friday",
    });
    expect(mockedExecuteTodoistTool).toHaveBeenCalledWith("todoist_create_task", {
      content: "New task",
      due_string: "next friday",
    });
    expect(result).toBe("todoist result");
  });

  it("returns 'Unknown tool' for unrecognized tool name", async () => {
    const result = await executeTool("nonexistent_tool", {});
    expect(result).toBe("Unknown tool: nonexistent_tool");
    expect(mockedExecuteWebTool).not.toHaveBeenCalled();
    expect(mockedExecuteTodoistTool).not.toHaveBeenCalled();
  });

  it("returns 'Unknown tool' for empty tool name", async () => {
    const result = await executeTool("", {});
    expect(result).toBe("Unknown tool: ");
  });

  it("does not dispatch web tools to todoist executor", async () => {
    await executeTool("search_web", { query: "test" });
    expect(mockedExecuteTodoistTool).not.toHaveBeenCalled();
  });

  it("does not dispatch todoist tools to web executor", async () => {
    await executeTool("todoist_list_tasks", {});
    expect(mockedExecuteWebTool).not.toHaveBeenCalled();
  });
});
