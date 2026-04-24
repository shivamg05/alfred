import { config } from "../config.js";

const BASE = "https://api.todoist.com/api/v1";

export interface TodoistTask {
  id: string;
  content: string;
  due?: { string: string; date: string; datetime?: string; is_recurring?: boolean };
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
    const normalized = normalizeKnownFilter(filter);
    const tasks = normalized
      ? localFilterTasks(await fetchAllTasks(), normalized)
      : await fetchAllTasks(filter);
    if (!filter) _rawTaskCache = tasks;
    return sortTasks(tasks);
  } catch (err) {
    console.error("[todoist] failed to fetch tasks:", err);
    return [];
  }
}

async function fetchAllTasks(filter?: string): Promise<TodoistTask[]> {
  const tasks: TodoistTask[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams();
    if (filter) params.set("filter", filter);
    if (cursor) params.set("cursor", cursor);
    const qs = params.toString();
    const res = await fetch(`${BASE}/tasks${qs ? `?${qs}` : ""}`, { headers: headers() });
    if (!res.ok) throw new Error(`Todoist API ${res.status}`);
    const body = await res.json();
    if (Array.isArray(body)) {
      tasks.push(...body as TodoistTask[]);
      break;
    }
    tasks.push(...(body?.results ?? []) as TodoistTask[]);
    cursor = body?.next_cursor ?? null;
  } while (cursor);
  if (!filter) _rawTaskCache = tasks;
  return tasks;
}

type KnownFilter = "today_overdue" | "today" | "overdue" | "week";

function normalizeKnownFilter(filter?: string): KnownFilter | null {
  const f = filter?.toLowerCase().trim();
  if (!f) return null;
  if (f === "today | overdue" || f === "overdue | today") return "today_overdue";
  if (f === "today") return "today";
  if (f === "overdue") return "overdue";
  if (f === "due before: +7 days" || f.includes("+7 days") || f.includes("next 7")) return "week";
  return null;
}

function localDateString(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config().USER_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${day}`;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dueDate(task: TodoistTask): string | null {
  return task.due?.date ?? task.due?.datetime?.slice(0, 10) ?? null;
}

function localFilterTasks(tasks: TodoistTask[], filter: KnownFilter): TodoistTask[] {
  const today = localDateString();
  const inSevenDays = addDays(today, 7);
  return tasks.filter((task) => {
    const due = dueDate(task);
    if (!due) return false;
    if (filter === "today") return due === today;
    if (filter === "overdue") return due < today;
    if (filter === "today_overdue") return due <= today;
    if (filter === "week") return due <= inSevenDays;
    return true;
  });
}

function taskUrgency(task: TodoistTask): number {
  const today = localDateString();
  const due = dueDate(task);
  if (!due) return 4;
  if (due < today) return 0;
  if (due === today) return 1;
  return 2;
}

function sortTasks(tasks: TodoistTask[]): TodoistTask[] {
  return [...tasks].sort((a, b) => {
    const urgency = taskUrgency(a) - taskUrgency(b);
    if (urgency !== 0) return urgency;
    const dueA = dueDate(a) ?? "9999-12-31";
    const dueB = dueDate(b) ?? "9999-12-31";
    if (dueA !== dueB) return dueA.localeCompare(dueB);
    return b.priority - a.priority;
  });
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
