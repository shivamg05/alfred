import {
  getTasks,
  closeTask,
  updateTask,
  createTask,
} from "../integrations/todoist.js";

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
      return tasks
        .map(
          (t) =>
            `id:${t.id} | ${t.content}${t.due ? ` (due: ${t.due.string})` : ""}`,
        )
        .join("\n");
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
