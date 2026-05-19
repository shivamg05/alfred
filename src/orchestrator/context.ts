import { ConversationBuffer } from "../memory/shortTerm.js";
import { retrieveContext } from "../memory/retrieval.js";
import { buildSystemPrompt } from "../tone/systemPrompt.js";
import { getTasks, formatTasksForContext } from "../integrations/todoist.js";
import { config } from "../config.js";
import { ResponseMode } from "./classifier.js";
import { logPrompt } from "../debug/promptLog.js";

let _cachedTasksStr: string = "none";
let _lastTaskFetch = 0;
const TASK_CACHE_MS = 30 * 60 * 1000;

async function getTaskContext(): Promise<string> {
  if (!config().TODOIST_API_TOKEN) return "";
  const now = Date.now();
  if (now - _lastTaskFetch > TASK_CACHE_MS) {
    const tasks = await getTasks("due before: +7 days");
    _cachedTasksStr = formatTasksForContext(tasks);
    _lastTaskFetch = now;
  }
  return _cachedTasksStr;
}

export interface ContextData {
  memoryContext: Awaited<ReturnType<typeof retrieveContext>>;
  recentMessages: ReturnType<ConversationBuffer["getForPrompt"]>;
  sessionSummary: string | null;
  decisionLog: string | null;
  todoistTasks: string;
}

export interface FetchContextOptions {
  includeTodoist?: boolean;
}

/** Retrieval only — mode-independent. Safe to run in parallel with classifyIntent. */
export async function fetchContext(
  buffer: ConversationBuffer,
  opts: FetchContextOptions = {},
): Promise<ContextData> {
  // Use capped prompt window (last 12) — older messages are in sessionSummary
  const recentMessages = buffer.getForPrompt();
  const sessionSummary = buffer.sessionSummary;
  const decisionLog = buffer.decisionLog;
  const latestUserMsg =
    recentMessages.filter((m) => m.role === "user").at(-1)?.content ?? "";

  const [memoryContext, todoistTasks] = await Promise.all([
    retrieveContext(latestUserMsg),
    opts.includeTodoist ? getTaskContext() : Promise.resolve(""),
  ]);

  return { memoryContext, recentMessages, sessionSummary, decisionLog, todoistTasks };
}

/** Assembles the final system prompt once mode is known. */
export function buildPrompt(data: ContextData, mode: ResponseMode): string {
  console.log(
    `[context] mode=${mode} history=${data.recentMessages.length}msgs ` +
    `summary=${data.sessionSummary ? `${data.sessionSummary.length}ch` : "none"} ` +
    `log=${data.decisionLog ? `${data.decisionLog.length}ch` : "none"} ` +
    `identity=${data.memoryContext.identity.length} bedrock=${data.memoryContext.bedrock.length} ` +
    `retrieved=${data.memoryContext.retrieved.length} ` +
    `todoist=${data.todoistTasks ? "yes" : "no"}`,
  );
  const prompt = buildSystemPrompt(data.memoryContext, data.recentMessages, data.todoistTasks, mode, data.sessionSummary, data.decisionLog);
  logPrompt("system", prompt, {
    userMessage: data.recentMessages.filter((m) => m.role === "user").at(-1)?.content,
    meta: { mode },
  });
  return prompt;
}

/** Convenience wrapper (keeps existing callers working). */
export async function buildContext(
  buffer: ConversationBuffer,
  mode: ResponseMode = "full",
): Promise<string> {
  return buildPrompt(await fetchContext(buffer), mode);
}
