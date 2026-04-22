import { ConversationBuffer } from "../memory/shortTerm.js";
import { retrieveContext } from "../memory/retrieval.js";
import { buildSystemPrompt } from "../tone/systemPrompt.js";
import { getTasks, formatTasksForContext } from "../integrations/todoist.js";
import { config } from "../config.js";

let _cachedTasks: string = "none";
let _lastTaskFetch = 0;
const TASK_CACHE_MS = 30 * 60 * 1000; // 30 min

async function getCachedTasks(): Promise<string> {
  if (!config().TODOIST_API_TOKEN) return "";
  const now = Date.now();
  if (now - _lastTaskFetch > TASK_CACHE_MS) {
    const tasks = await getTasks();
    _cachedTasks = formatTasksForContext(tasks);
    _lastTaskFetch = now;
  }
  return _cachedTasks;
}

export async function buildContext(
  buffer: ConversationBuffer,
): Promise<string> {
  const recentMessages = buffer.getRecent(20);
  const latestUserMsg = recentMessages.filter((m) => m.role === "user").at(-1)?.content ?? "";

  const [memoryContext, todoistTasks] = await Promise.all([
    retrieveContext(latestUserMsg),
    getCachedTasks(),
  ]);

  return buildSystemPrompt(memoryContext, recentMessages, todoistTasks);
}
