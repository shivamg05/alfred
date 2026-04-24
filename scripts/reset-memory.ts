/**
 * Reset Alfred's learned memory.
 *
 * Usage:
 *   pnpm memory:reset -- --yes
 *   pnpm memory:reset -- --yes --include-messages
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

import Database from "better-sqlite3";
import { ChromaClient } from "chromadb";
import { config } from "../src/config.js";

if (!process.argv.includes("--yes")) {
  console.error("Refusing to reset memory without --yes");
  console.error("Usage: pnpm memory:reset -- --yes [--include-messages]");
  process.exit(1);
}

const cfg = config();
const db = new Database(cfg.DB_PATH);
const includeMessages = process.argv.includes("--include-messages");

db.pragma("foreign_keys = OFF");
db.transaction(() => {
  db.prepare("DELETE FROM fact_relations").run();
  db.prepare("UPDATE memory_facts SET parent_fact_id = NULL, root_fact_id = NULL").run();
  db.prepare("DELETE FROM memory_facts").run();
  db.prepare("INSERT INTO memory_facts_fts(memory_facts_fts) VALUES ('rebuild')").run();
  db.prepare("DELETE FROM user_profile").run();
  db.prepare("DELETE FROM reminders").run();
  db.prepare("DELETE FROM proactive_log").run();
  if (includeMessages) db.prepare("DELETE FROM messages").run();
  db.prepare(
    `DELETE FROM sqlite_sequence
     WHERE name IN ('memory_facts', 'fact_relations', 'user_profile', 'reminders', 'proactive_log'
       ${includeMessages ? ", 'messages'" : ""})`,
  ).run();
})();
db.pragma("foreign_keys = ON");

db.close();
console.log(`[reset-memory] cleared SQLite memory tables${includeMessages ? " and raw message history" : ""}`);

try {
  const chroma = new ChromaClient({ host: "localhost", port: cfg.CHROMA_PORT });
  await chroma.deleteCollection({ name: "alfred_facts" });
  console.log("[reset-memory] deleted ChromaDB collection alfred_facts");
} catch (err) {
  console.error("[reset-memory] ChromaDB collection delete failed or collection did not exist:", err);
}
