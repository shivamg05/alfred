import type OpenAI from "openai";
import { config } from "../config.js";
import { executeWebTool } from "./web.js";
import { executeTodoistTool } from "./todoist.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const WEB_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description:
        "Search the web for current information — news, weather, facts, prices, recent events, people, places, anything that benefits from live data. Use freely whenever the question might require up-to-date knowledge.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scrape_url",
      description:
        "Read the full content of a specific URL. Use when the user shares a link, or when a search result looks relevant and you want the full text.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL to fetch" },
        },
        required: ["url"],
      },
    },
  },
];

const TODOIST_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "todoist_list_tasks",
      description: `List the user's Todoist tasks. Always call this before closing or updating a task — you need the task ID.

Use the right filter for the intent:
- User asks if they finished everything / are all caught up / did everything today → filter: "today | overdue"
- User asks about overdue / late / behind / past-due tasks → filter: "overdue"
- User asks what's due today / today's tasks → filter: "today"
- User asks what's coming up / due soon / this week → filter: "due before: +7 days"
- User asks about everything on their plate → filter: "today | overdue" (don't list all tasks — that includes far-future items)
- You need a task ID to act on a specific task → call with the narrowest filter that will find it

Only omit the filter when the user explicitly wants to see ALL tasks including far-future ones.`,
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            description:
              "Todoist filter string. Use 'today | overdue' for completeness checks. Use 'overdue' for past-due queries. Use 'today' for today-only. Use 'due before: +7 days' for upcoming. Omit only when all tasks including far-future ones are wanted.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todoist_close_task",
      description: "Mark a task as complete. Requires the task ID from todoist_list_tasks.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID from list_tasks" },
          task_name: { type: "string", description: "Task name (for confirmation)" },
        },
        required: ["task_id", "task_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todoist_update_task",
      description:
        "Rename or reschedule an existing task. Requires the task ID from todoist_list_tasks. Provide at least one of content or due_string.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          task_name: { type: "string", description: "Current task name (for confirmation)" },
          content: { type: "string", description: "New task title (optional)" },
          due_string: {
            type: "string",
            description: "New due date in natural language, e.g. 'tomorrow', 'next Friday' (optional)",
          },
        },
        required: ["task_id", "task_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todoist_create_task",
      description: "Create a new task when the user explicitly asks to add one.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Task title" },
          due_string: {
            type: "string",
            description: "Due date in natural language (optional)",
          },
        },
        required: ["content"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns the tool set available given the current config. */
export function getTools(): OpenAI.Chat.ChatCompletionTool[] {
  const cfg = config();
  const tools: OpenAI.Chat.ChatCompletionTool[] = [];
  if (cfg.FIRECRAWL_API_KEY) tools.push(...WEB_TOOLS);
  if (cfg.TODOIST_API_TOKEN) tools.push(...TODOIST_TOOLS);
  return tools;
}

/** Dispatch a tool call by name. */
export async function executeTool(
  name: string,
  args: Record<string, string>,
): Promise<string> {
  console.log(`[tools] ${name}(${JSON.stringify(args)})`);
  if (name === "search_web" || name === "scrape_url") {
    return executeWebTool(name, args);
  }
  if (name.startsWith("todoist_")) {
    return executeTodoistTool(name, args);
  }
  return `Unknown tool: ${name}`;
}
