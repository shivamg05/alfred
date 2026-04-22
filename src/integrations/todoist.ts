import { config } from "../config.js";

const BASE = "https://api.todoist.com/api/v1";

export interface TodoistTask {
  id: string;
  content: string;
  due?: { string: string; date: string };
  priority: number;  // 1 (normal) to 4 (urgent)
  project_id: string;
}

// Raw task cache — kept in sync whenever getTasks() is called
let _rawTaskCache: TodoistTask[] = [];

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${config().TODOIST_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

export async function getTasks(filter?: string): Promise<TodoistTask[]> {
  const token = config().TODOIST_API_TOKEN;
  if (!token) return [];

  try {
    const url = filter
      ? `${BASE}/tasks?filter=${encodeURIComponent(filter)}`
      : `${BASE}/tasks`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`Todoist API ${res.status}`);
    const body = await res.json();
    // v1 API returns { results: [...], next_cursor: ... }; v2 returned a bare array
    const tasks = Array.isArray(body) ? body : (body?.results ?? []);
    // Only update the main cache for unfiltered fetches
    if (!filter) _rawTaskCache = tasks as TodoistTask[];
    return tasks as TodoistTask[];
  } catch (err) {
    console.error("[todoist] failed to fetch tasks:", err);
    return [];
  }
}

/** Returns the last-fetched task list without making a network request. */
export function getCachedRawTasks(): TodoistTask[] {
  return _rawTaskCache;
}

export async function createTask(opts: {
  content: string;
  due_string?: string;
}): Promise<TodoistTask | null> {
  const token = config().TODOIST_API_TOKEN;
  if (!token) return null;

  try {
    // Use the provided due_string if it looks like a real date; otherwise default to "today".
    // LLM sometimes writes "no specific due date" or similar which Todoist rejects with a 400.
    const hasRealDate = opts.due_string &&
      /\d|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next|week|month|morning|evening|night/i.test(opts.due_string);
    const dueString = hasRealDate ? opts.due_string : "today";

    const res = await fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        content: opts.content,
        due_string: dueString,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      throw new Error(`Todoist API ${res.status}: ${body}`);
    }
    return (await res.json()) as TodoistTask;
  } catch (err) {
    console.error("[todoist] failed to create task:", err);
    return null;
  }
}

export async function closeTask(id: string): Promise<boolean> {
  const token = config().TODOIST_API_TOKEN;
  if (!token) return false;

  try {
    const res = await fetch(`${BASE}/tasks/${id}/close`, {
      method: "POST",
      headers: headers(),
    });
    if (!res.ok) throw new Error(`Todoist API ${res.status}`);
    // 204 No Content on success — remove from local cache
    _rawTaskCache = _rawTaskCache.filter((t) => t.id !== id);
    return true;
  } catch (err) {
    console.error("[todoist] failed to close task:", err);
    return false;
  }
}

export async function updateTask(
  id: string,
  opts: { content?: string; due_string?: string },
): Promise<TodoistTask | null> {
  const token = config().TODOIST_API_TOKEN;
  if (!token) return null;

  try {
    const res = await fetch(`${BASE}/tasks/${id}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(opts),
    });
    if (!res.ok) throw new Error(`Todoist API ${res.status}`);
    const updated = (await res.json()) as TodoistTask;
    // Keep local cache in sync
    _rawTaskCache = _rawTaskCache.map((t) => (t.id === id ? updated : t));
    return updated;
  } catch (err) {
    console.error("[todoist] failed to update task:", err);
    return null;
  }
}

/**
 * Fuzzy-match a user's description to the closest task.
 * Priority: exact match → substring → word overlap (≥50%).
 */
export function findTaskByMatch(
  match: string,
  tasks: TodoistTask[],
): TodoistTask | undefined {
  if (!match || tasks.length === 0) return undefined;
  const needle = match.toLowerCase().trim();

  // 1. Exact content match
  const exact = tasks.find((t) => t.content.toLowerCase() === needle);
  if (exact) return exact;

  // 2. Substring match — prefer the shortest task (most specific)
  const contains = tasks
    .filter((t) => t.content.toLowerCase().includes(needle))
    .sort((a, b) => a.content.length - b.content.length);
  if (contains.length > 0) return contains[0];

  // 3. Word overlap — need ≥50% of needle words to appear in the task
  const needleWords = needle.split(/\s+/).filter(Boolean);
  let best: TodoistTask | undefined;
  let bestScore = 0;
  for (const task of tasks) {
    const taskWords = task.content.toLowerCase().split(/\s+/);
    const overlap = needleWords.filter((w) =>
      taskWords.some((tw) => tw.includes(w)),
    ).length;
    const score = overlap / needleWords.length;
    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      best = task;
    }
  }
  return best;
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
