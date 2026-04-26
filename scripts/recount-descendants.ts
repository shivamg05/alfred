/**
 * One-time script: recompute descendant_count for every fact.
 *
 * The old propagateDescendantIncrement always incremented by +1 regardless
 * of a child's existing subtree size, so parent counts were under-counted
 * whenever a child was wired after it already had its own descendants.
 *
 * recalculateDescendantCount() does a full recursive walk from each node,
 * so running it on all facts produces correct absolute counts.
 */

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
loadEnv({ path: __envPath });

import { db } from "../src/db/schema.js";
import { recalculateDescendantCount } from "../src/memory/facts.js";

db(); // initialise schema

const rows = db()
  .prepare("SELECT id FROM memory_facts ORDER BY id ASC")
  .all() as { id: number }[];

console.log(`[recount] recalculating descendant_count for ${rows.length} facts...`);

for (const { id } of rows) {
  const count = recalculateDescendantCount(id);
  if (count > 0) console.log(`[recount] fact_${id}: ${count} descendants`);
}

console.log("[recount] done");
