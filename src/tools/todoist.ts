import {
  getTasks,
  closeTask,
  updateTask,
  createTask,
  TodoistTask,
} from "../integrations/todoist.js";
import { config } from "../config.js";

function localDateString(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config().USER_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  return `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}-${parts.find((p) => p.type === "day")?.value}`;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dueDate(task: TodoistTask): string | null {
  return task.due?.date ?? task.due?.datetime?.slice(0, 10) ?? null;
}

function formatTask(task: TodoistTask): string {
  const due = task.due ? `due: ${task.due.string}` : "no due date";
  const priority = task.priority >= 4 ? " | priority: urgent" : task.priority >= 3 ? " | priority: high" : "";
  return `id:${task.id} | ${task.content} (${due}${priority})`;
}

function formatTaskSections(tasks: TodoistTask[], filter?: string): string {
  if (!filter) {
    return `ALL OPEN TASKS:\n${tasks.map(formatTask).join("\n")}`;
  }
  const today = localDateString();
  const soon = addDays(today, 7);
  const overdue = tasks.filter((t) => {
    const due = dueDate(t);
    return due && due < today;
  });
  const dueToday = tasks.filter((t) => dueDate(t) === today);
  const upcoming = tasks.filter((t) => {
    const due = dueDate(t);
    return due && due > today && due <= soon;
  });

  const sections: string[] = [];
  sections.push("Use this priority order in your reply: overdue first, due today second, upcoming this week third. Do not mention far-future tasks unless the user asked for all tasks.");
  if (overdue.length > 0) sections.push(`OVERDUE:\n${overdue.map(formatTask).join("\n")}`);
  if (dueToday.length > 0) sections.push(`DUE TODAY:\n${dueToday.map(formatTask).join("\n")}`);
  if (upcoming.length > 0 && filter?.toLowerCase().includes("7")) {
    sections.push(`UPCOMING THIS WEEK:\n${upcoming.map(formatTask).join("\n")}`);
  }
  if (overdue.length === 0 && dueToday.length === 0 && (!filter?.toLowerCase().includes("7") || upcoming.length === 0)) {
    sections.push("No overdue or due-today tasks found.");
  }

  return sections.join("\n\n");
}

/**
 * Execute a todoist_* tool call.
 * The agent always calls todoist_list_tasks first to get real task IDs
 * before closing or updating anything.
 */
export async function executeTodoistTool(
  name: string,
  args: Record<string, string>,
): Promise<string> {
  try {
    if (name === "todoist_list_tasks") {
      const tasks = await getTasks(args.filter);
      if (tasks.length === 0) {
        return args.filter
          ? `No tasks match filter "${args.filter}".`
          : "No open tasks.";
      }
      return formatTaskSections(tasks, args.filter);
    }

    if (name === "todoist_close_task") {
      const ok = await closeTask(args.task_id);
      return ok
        ? `Closed "${args.task_name ?? args.task_id}"`
        : `Failed to close task.`;
    }

    if (name === "todoist_update_task") {
      const opts: { content?: string; due_string?: string } = {};
      if (args.content) opts.content = args.content;
      if (args.due_string) opts.due_string = args.due_string;
      const updated = await updateTask(args.task_id, opts);
      if (!updated) return `Failed to update task.`;
      const changes = [
        args.content ? `renamed to "${updated.content}"` : null,
        updated.due ? `due ${updated.due.string}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `Updated "${args.task_name ?? args.task_id}": ${changes}`;
    }

    if (name === "todoist_create_task") {
      const created = await createTask({
        content: args.content,
        due_string: args.due_string,
      });
      return created
        ? `Created task: "${args.content}"`
        : `Failed to create task.`;
    }

    return `Unknown todoist tool: ${name}`;
  } catch (err) {
    console.error(`[tools/todoist] ${name} failed:`, err);
    return `Error running ${name}: ${String(err)}`;
  }
}
