/**
 * Captures the last prompt of each type to a JSON file so you can
 * inspect exactly what Alfred is sending to the LLM.
 *
 * Usage from code:   logPrompt("system", promptText)
 * Usage from CLI:    pnpm prompts
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(__dirname, "../../.prompt-log.json");

export type PromptType = "system" | "classifier" | "ack" | "extraction" | "session_summary" | "decision_log" | "proactive";

interface PromptEntry {
  type: PromptType;
  content: string;
  /** The user message that triggered this prompt (if applicable). */
  userMessage?: string;
  timestamp: string;
  /** Extra metadata (mode, model, etc.) */
  meta?: Record<string, string>;
}

interface PromptLog {
  /** Last prompt of each type, keyed by PromptType. */
  [key: string]: PromptEntry;
}

/**
 * Save a prompt snapshot. Overwrites the previous entry for that type.
 * Fire-and-forget — never throws.
 */
export function logPrompt(
  type: PromptType,
  content: string,
  opts: { userMessage?: string; meta?: Record<string, string> } = {},
): void {
  try {
    let log: PromptLog = {};
    if (existsSync(LOG_PATH)) {
      log = JSON.parse(readFileSync(LOG_PATH, "utf-8")) as PromptLog;
    }
    log[type] = {
      type,
      content,
      userMessage: opts.userMessage,
      timestamp: new Date().toISOString(),
      meta: opts.meta,
    };
    writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
  } catch {
    // best-effort — don't crash Alfred for debug tooling
  }
}

/** Read the current prompt log. Returns null if no log exists. */
export function readPromptLog(): PromptLog | null {
  try {
    if (!existsSync(LOG_PATH)) return null;
    return JSON.parse(readFileSync(LOG_PATH, "utf-8")) as PromptLog;
  } catch {
    return null;
  }
}

export { LOG_PATH };
