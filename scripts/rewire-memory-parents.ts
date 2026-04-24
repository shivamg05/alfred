/**
 * Repairs instance_of parent wiring for existing facts.
 *
 * This is useful after changing parent-wiring thresholds or after importing a
 * graph that has same-level relates_to edges but sparse abstraction edges.
 *
 * Usage:
 *   pnpm memory:rewire
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

import { db } from "../src/db/schema.js";
import {
  getFactById,
  getFactsByLevel,
  insertInstanceOfRelation,
  recalculateDescendantCount,
} from "../src/memory/facts.js";
import { querySimilarFacts } from "../src/memory/vectors.js";

const DISTANCE_THRESHOLD = 0.42;
const MAX_PARENTS_PER_FACT = 3;

async function wireLevel(childLevel: 0 | 1, parentLevel: 1 | 2): Promise<number> {
  let inserted = 0;
  const children = getFactsByLevel(childLevel, 1000);

  for (const child of children) {
    const hits = await querySimilarFacts(child.text, 10, { abstraction_level: parentLevel });
    let parentCount = 0;
    for (const hit of hits) {
      if (parentCount >= MAX_PARENTS_PER_FACT) break;
      if (hit.factId === child.id || hit.distance > DISTANCE_THRESHOLD) continue;
      const parent = getFactById(hit.factId);
      if (!parent || !parent.is_latest || parent.is_forgotten) continue;
      if (parent.abstraction_level !== parentLevel) continue;
      if (insertInstanceOfRelation(child.id, parent.id, { propagate: false })) {
        inserted += 1;
      }
      parentCount += 1;
    }
  }

  return inserted;
}

async function main(): Promise<void> {
  console.log("[memory-rewire] scanning active L0/L1 facts for missing instance_of parents");

  db().prepare("UPDATE memory_facts SET descendant_count = 0").run();

  const l0Edges = await wireLevel(0, 1);
  const l1Edges = await wireLevel(1, 2);

  const roots = [...getFactsByLevel(1, 1000), ...getFactsByLevel(2, 1000)];
  for (const fact of roots) recalculateDescendantCount(fact.id);

  console.log(`[memory-rewire] inserted ${l0Edges} L0->L1 edge(s), ${l1Edges} L1->L2 edge(s)`);
  console.log("[memory-rewire] descendant counts recalculated");
}

main()
  .catch((err) => {
    console.error("[memory-rewire] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => db().close());
