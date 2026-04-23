import { ConversationBuffer } from "../memory/shortTerm.js";
import { retrieveContext } from "../memory/retrieval.js";
import { buildSystemPrompt } from "../tone/systemPrompt.js";
import { getTasks, formatTasksForContext } from "../integrations/todoist.js";
import { config } from "../config.js";
import { ResponseMode } from "./classifier.js";

let _cachedTasksStr: string = "none";
let _lastTaskFetch = 0;
const TASK_CACHE_MS = 30 * 60 * 1000;

async function getTaskContext(): Promise<string> {
  if (!config().TODOIST_API_TOKEN) return "";
  const now = Date.now();
  if (now - _lastTaskFetch > TASK_CACHE_MS) {
    const tasks = await getTasks();
    _cachedTasksStr = formatTasksForContext(tasks);
    _lastTaskFetch = now;
  }
  return _cachedTasksStr;
}

export interface ContextData {
  memoryContext: Awaited<ReturnType<typeof retrieveContext>>;
  recentMessages: ReturnType<ConversationBuffer["getRecent"]>;
  todoistTasks: string;
}

/** Retrieval only — mode-independent. Safe to run in parallel with classifyIntent. */
export async function fetchContext(buffer: ConversationBuffer): Promise<ContextData> {
  const recentMessages = buffer.getRecent(20);
  const latestUserMsg =
    recentMessages.filter((m) => m.role === "user").at(-1)?.content ?? "";

  const [memoryContext, todoistTasks] = await Promise.all([
    retrieveContext(latestUserMsg),
    getTaskContext(),
  ]);

  return { memoryContext, recentMessages, todoistTasks };
}

/** Assembles the final system prompt once mode is known. */
export function buildPrompt(data: ContextData, mode: ResponseMode): string {
  console.log(
    `[context] mode=${mode} history=${data.recentMessages.length}msgs ` +
    `bedrock=${data.memoryContext.bedrock.length} retrieved=${data.memoryContext.retrieved.length} ` +
    `todoist=${data.todoistTasks ? "yes" : "no"}`,
  );
  return buildSystemPrompt(data.memoryContext, data.recentMessages, data.todoistTasks, mode);
}

/** Convenience wrapper (keeps existing callers working). */
export async function buildContext(
  buffer: ConversationBuffer,
  mode: ResponseMode = "full",
): Promise<string> {
  return buildPrompt(await fetchContext(buffer), mode);
}
