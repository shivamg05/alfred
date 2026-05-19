/**
 * Displays the last captured prompt of each type.
 * Usage: pnpm prompts [type]
 *
 * Examples:
 *   pnpm prompts              — show all prompt types (truncated)
 *   pnpm prompts system       — show full system prompt
 *   pnpm prompts classifier   — show full classifier prompt
 *   pnpm prompts extraction   — show full extraction prompt
 */

import { readPromptLog, LOG_PATH } from "../src/debug/promptLog.js";
import type { PromptType } from "../src/debug/promptLog.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const GRAY = "\x1b[90m";
const MAGENTA = "\x1b[35m";

const log = readPromptLog();
if (!log) {
  console.log(`\n${YELLOW}No prompt log found at ${LOG_PATH}${RESET}`);
  console.log(`${DIM}Start Alfred and send a message to populate the log.${RESET}\n`);
  process.exit(0);
}

const requestedType = process.argv[2] as PromptType | undefined;

const typeOrder: PromptType[] = ["system", "classifier", "ack", "extraction", "session_summary", "decision_log", "proactive"];
const typeLabels: Record<PromptType, string> = {
  system: "SYSTEM PROMPT",
  classifier: "CLASSIFIER PROMPT",
  ack: "ACK GENERATOR",
  extraction: "EXTRACTION PROMPT",
  session_summary: "SESSION SUMMARY PROMPT",
  decision_log: "DECISION LOG PROMPT",
  proactive: "PROACTIVE PROMPT",
};

const typeColors: Record<PromptType, string> = {
  system: CYAN,
  classifier: GREEN,
  ack: MAGENTA,
  extraction: YELLOW,
  session_summary: MAGENTA,
  decision_log: GREEN,
  proactive: YELLOW,
};

console.log(`\n${BOLD}ALFRED PROMPT LOG${RESET}  ${DIM}(${LOG_PATH})${RESET}\n`);

if (requestedType) {
  // Show full prompt for the requested type
  const entry = log[requestedType];
  if (!entry) {
    console.log(`${YELLOW}No '${requestedType}' prompt found in log.${RESET}`);
    console.log(`${DIM}Available types: ${Object.keys(log).join(", ")}${RESET}\n`);
    process.exit(0);
  }

  const color = typeColors[requestedType] ?? CYAN;
  const label = typeLabels[requestedType] ?? requestedType.toUpperCase();
  const ago = timeSince(entry.timestamp);

  console.log(`${BOLD}${color}${label}${RESET}  ${DIM}(${ago})${RESET}`);
  if (entry.userMessage) {
    console.log(`${DIM}user message: ${entry.userMessage}${RESET}`);
  }
  if (entry.meta) {
    console.log(`${DIM}meta: ${JSON.stringify(entry.meta)}${RESET}`);
  }
  console.log(`${"─".repeat(72)}`);
  console.log(entry.content);
  console.log(`${"─".repeat(72)}`);
  console.log(`${DIM}${entry.content.length} chars${RESET}\n`);
} else {
  // Show summary of all types
  for (const type of typeOrder) {
    const entry = log[type];
    if (!entry) continue;

    const color = typeColors[type] ?? CYAN;
    const label = typeLabels[type] ?? type.toUpperCase();
    const ago = timeSince(entry.timestamp);
    const preview = entry.content.replace(/\n/g, " ").slice(0, 120);

    console.log(`${BOLD}${color}${label}${RESET}  ${DIM}(${ago})${RESET}`);
    if (entry.userMessage) {
      console.log(`  ${DIM}user: "${entry.userMessage.slice(0, 80)}"${RESET}`);
    }
    if (entry.meta) {
      console.log(`  ${DIM}${Object.entries(entry.meta).map(([k, v]) => `${k}=${v}`).join(" ")}${RESET}`);
    }
    console.log(`  ${GRAY}${preview}...${RESET}`);
    console.log(`  ${DIM}${entry.content.length} chars — run \`pnpm prompts ${type}\` for full text${RESET}`);
    console.log();
  }
}

function timeSince(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
