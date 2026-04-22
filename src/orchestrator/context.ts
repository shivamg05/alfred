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

export async function buildContext(
  buffer: ConversationBuffer,
  mode: ResponseMode = "full",
): Promise<string> {
  const recentMessages = buffer.getRecent(20);
  const latestUserMsg =
    recentMessages.filter((m) => m.role === "user").at(-1)?.content ?? "";

  const [memoryContext, todoistTasks] = await Promise.all([
    retrieveContext(latestUserMsg),
    getTaskContext(),
  ]);

  return buildSystemPrompt(memoryContext, recentMessages, todoistTasks, mode);
}
