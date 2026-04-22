import OpenAI from "openai";
import { config } from "../config.js";
import { getTasks, closeTask, updateTask, createTask } from "./todoist.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_tasks",
      description:
        "Fetch the user's open Todoist tasks. Always call this first to find task IDs before acting on tasks. Supports Todoist filter syntax: 'today', 'overdue', 'due before: tomorrow', 'p1', etc. Leave filter empty to get all open tasks.",
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            description:
              "Todoist filter string. Examples: 'today', 'overdue', 'due before: tomorrow'. Omit to list all open tasks.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_task",
      description: "Mark a task as complete / done.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "ID of the task to close" },
          task_name: { type: "string", description: "Task name (used for confirmation)" },
        },
        required: ["task_id", "task_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description: "Update an existing task's content or due date. At least one of content or due_string must be provided.",
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
      name: "create_task",
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
// System prompt
// ---------------------------------------------------------------------------

const AGENT_SYSTEM = `You are a Todoist assistant embedded in a personal AI. Your job is to detect Todoist-related intent in the user's message and use the available tools to execute the right operations.

WHEN TO ACT:
- User says they finished/completed something → close the matching task(s)
- User says "all my tasks today", "my overdue tasks", etc. → call list_tasks with the right filter, then close/update each result
- User asks to reschedule or rename a task → update it
- User explicitly asks to add a task → create it

HOW TO ACT:
- Always call list_tasks first if you need to find which tasks to act on — never guess at task IDs
- You can call list_tasks multiple times with different filters if needed
- Close or update each relevant task individually after finding their IDs
- If the user's message has nothing to do with Todoist tasks, call no tools

WHAT NOT TO DO:
- Do not create tasks for implicit intent like "i need to call Jake" — that is handled elsewhere
- Do not act on tasks that weren't clearly mentioned
- Do not ask clarifying questions — just act or do nothing`;

// ---------------------------------------------------------------------------
// Agent result
// ---------------------------------------------------------------------------

export interface TodoistAgentResult {
  /** Human-readable list of what was done, e.g. ["✓ Buy groceries", "Updated 'dentist' → due Friday"] */
  actionsPerformed: string[];
  /** One-line summary injected into Alfred's context, empty if nothing happened */
  summary: string;
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export async function runTodoistAgent(
  userMessage: string,
): Promise<TodoistAgentResult> {
  const cfg = config();
  if (!cfg.TODOIST_API_TOKEN) return { actionsPerformed: [], summary: "" };

  const client = new OpenAI({
    apiKey: cfg.OPENAI_API_KEY,
    ...(cfg.LLM_BASE_URL ? { baseURL: cfg.LLM_BASE_URL } : {}),
  });

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: AGENT_SYSTEM },
    { role: "user", content: userMessage },
  ];

  const actionsPerformed: string[] = [];
  const MAX_ITERATIONS = 8; // enough for list + N close calls

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model: cfg.EXTRACTION_MODEL,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        max_tokens: 500,
      });
    } catch (err) {
      console.error("[todoist-agent] LLM call failed:", err);
      break;
    }

    const msg = response.choices[0].message;
    messages.push(msg);

    // No tool calls → agent is done
    if (!msg.tool_calls || msg.tool_calls.length === 0) break;

    // Execute every function-type tool call in this turn, then continue the loop
    for (const call of msg.tool_calls) {
      if (call.type !== "function") continue;
      let result: string;
      try {
        const args = JSON.parse(call.function.arguments) as Record<string, string>;
        result = await executeTool(call.function.name, args, actionsPerformed);
      } catch (err) {
        result = `Error: ${String(err)}`;
        console.error(`[todoist-agent] tool error (${call.function.name}):`, err);
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  const summary =
    actionsPerformed.length > 0
      ? `Todoist actions just completed: ${actionsPerformed.join(" | ")}`
      : "";

  return { actionsPerformed, summary };
}

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

async function executeTool(
  name: string,
  args: Record<string, string>,
  actionsPerformed: string[],
): Promise<string> {
  if (name === "list_tasks") {
    const tasks = await getTasks(args.filter);
    if (tasks.length === 0) {
      return args.filter
        ? `No tasks match filter "${args.filter}"`
        : "No open tasks found";
    }
    return tasks
      .map(
        (t) =>
          `id:${t.id} | ${t.content}${t.due ? ` (due: ${t.due.string})` : ""}`,
      )
      .join("\n");
  }

  if (name === "close_task") {
    const ok = await closeTask(args.task_id);
    if (ok) {
      actionsPerformed.push(`✓ ${args.task_name}`);
      return `Closed: "${args.task_name}"`;
    }
    return `Failed to close: "${args.task_name}"`;
  }

  if (name === "update_task") {
    const opts: { content?: string; due_string?: string } = {};
    if (args.content) opts.content = args.content;
    if (args.due_string) opts.due_string = args.due_string;
    const updated = await updateTask(args.task_id, opts);
    if (updated) {
      const detail = [
        args.content ? `renamed to "${updated.content}"` : null,
        updated.due ? `due ${updated.due.string}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      actionsPerformed.push(`Updated "${args.task_name}" (${detail})`);
      return `Updated: "${args.task_name}" — ${detail}`;
    }
    return `Failed to update: "${args.task_name}"`;
  }

  if (name === "create_task") {
    const created = await createTask({
      content: args.content,
      due_string: args.due_string,
    });
    if (created) {
      actionsPerformed.push(`Added "${args.content}"`);
      return `Created task: "${args.content}"`;
    }
    return `Failed to create task: "${args.content}"`;
  }

  return `Unknown tool: ${name}`;
}
