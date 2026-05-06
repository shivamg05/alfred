/**
 * Print proactive attempts, cron state, and recently sent messages.
 *
 * Usage:
 *   pnpm proactive:log
 *   pnpm proactive:log -- --limit 50
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

import Database from "better-sqlite3";
import { config } from "../src/config.js";

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg === -1 ? 25 : Number(process.argv[limitArg + 1] ?? 25);

const cfg = config();
const db = new Database(cfg.DB_PATH, { readonly: true, fileMustExist: true });

function tableExists(name: string): boolean {
  return !!(db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name) as { name: string } | undefined);
}

// ── Cron state ───────────────────────────────────────────────────────────────

console.log("\nCRON STATE\n");

if (!tableExists("cron_state")) {
  console.log("  (no cron_state table yet — restart Alfred once so migrations run)\n");
} else {
  const cronRows = db.prepare(
    "SELECT job_name, last_ran_at FROM cron_state ORDER BY job_name",
  ).all() as Array<{ job_name: string; last_ran_at: string }>;

  if (cronRows.length === 0) {
    console.log("  (no rows — jobs haven't run yet since v6 migration)\n");
  } else {
    const now = Date.now();
    for (const row of cronRows) {
      const lastRan = new Date(row.last_ran_at);
      const hoursAgo = ((now - lastRan.getTime()) / 3_600_000).toFixed(1);
      const overdue = parseFloat(hoursAgo) > 25 ? "  ⚠ OVERDUE" : "";
      console.log(
        `  ${row.job_name.padEnd(24)} ${hoursAgo.padStart(5)}h ago  (${row.last_ran_at})${overdue}`,
      );
    }
    console.log();
  }
}

// ── Recent sent messages ─────────────────────────────────────────────────────

console.log("RECENT SENT MESSAGES\n");

const sent = db.prepare(`
  SELECT sent_at, trigger_type, content_sent
  FROM proactive_log
  WHERE user_id = ?
  ORDER BY sent_at DESC
  LIMIT 10
`).all(cfg.USER_ID) as Array<{ sent_at: string; trigger_type: string; content_sent: string }>;

if (sent.length === 0) {
  console.log("  (none yet)\n");
} else {
  for (const row of sent) {
    const preview = row.content_sent.replace(/\s+/g, " ").slice(0, 120);
    console.log(`  ${row.sent_at}  ${row.trigger_type}`);
    console.log(`    "${preview}"`);
    console.log();
  }
}

// ── Proactive attempts ───────────────────────────────────────────────────────

if (!tableExists("proactive_attempts")) {
  console.log("\nPROACTIVE ATTEMPTS\n");
  console.log("  (no proactive_attempts table yet — restart Alfred once so migrations run)\n");
  db.close();
  process.exit(0);
}

const attempts = db.prepare(`
  SELECT created_at, trigger_type, decision, reason, candidate, context_summary
  FROM proactive_attempts
  WHERE user_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`).all(cfg.USER_ID, Number.isFinite(limit) ? limit : 25) as Array<{
  created_at: string;
  trigger_type: string;
  decision: string;
  reason: string;
  candidate: string | null;
  context_summary: string | null;
}>;

console.log(`PROACTIVE ATTEMPTS (${attempts.length})\n`);
for (const row of attempts) {
  const icon = row.decision === "sent" ? "✓" : row.decision === "blocked" ? "✗" : "–";
  const candidate = row.candidate?.replace(/\s+/g, " ").slice(0, 120) ?? "";
  console.log(`  ${icon} ${row.created_at}  ${row.trigger_type}  ${row.decision}  ${row.reason}`);
  if (row.context_summary) console.log(`    context: ${row.context_summary}`);
  if (candidate) console.log(`    candidate: "${candidate}"`);
  console.log();
}

db.close();
