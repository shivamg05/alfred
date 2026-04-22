import { config } from "../config.js";

const BASE = "https://api.todoist.com/rest/v2";

export interface TodoistTask {
  id: string;
  content: string;
  due?: { string: string; date: string };
  priority: number;  // 1 (normal) to 4 (urgent)
  project_id: string;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${config().TODOIST_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

export async function getTasks(): Promise<TodoistTask[]> {
  const token = config().TODOIST_API_TOKEN;
  if (!token) return [];

  try {
    const res = await fetch(`${BASE}/tasks`, { headers: headers() });
    if (!res.ok) throw new Error(`Todoist API ${res.status}`);
    return (await res.json()) as TodoistTask[];
  } catch (err) {
    console.error("[todoist] failed to fetch tasks:", err);
    return [];
  }
}

export async function createTask(opts: {
  content: string;
  due_string?: string;
}): Promise<TodoistTask | null> {
  const token = config().TODOIST_API_TOKEN;
  if (!token) return null;

  try {
    const res = await fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        content: opts.content,
        ...(opts.due_string ? { due_string: opts.due_string } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Todoist API ${res.status}`);
    return (await res.json()) as TodoistTask;
  } catch (err) {
    console.error("[todoist] failed to create task:", err);
    return null;
  }
}

export function formatTasksForContext(tasks: TodoistTask[]): string {
  if (tasks.length === 0) return "none";
  return tasks
    .slice(0, 15)  // cap at 15 so we don't bloat the context
    .map((t) => {
      const due = t.due ? ` (due: ${t.due.string})` : "";
      const priority = t.priority === 4 ? " ‼️" : t.priority === 3 ? " ❗" : "";
      return `- ${t.content}${due}${priority}`;
    })
    .join("\n");
}
