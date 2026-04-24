/**
 * Prints the memory knowledge graph to stdout.
 * Usage: pnpm tsx scripts/memory-graph.ts [--static] [--dynamic] [--all] [--search <term>]
 *
 * By default shows all facts with their edge connections.
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

import Database from "better-sqlite3";
import { config } from "../src/config.js";

const cfg = config();
const db = new Database(cfg.DB_PATH, { readonly: true });
const userId = cfg.USER_ID ?? "local";

const args = process.argv.slice(2);
const filterStatic = args.includes("--static");
const filterDynamic = args.includes("--dynamic");
const searchIdx = args.indexOf("--search");
const searchTerm = searchIdx !== -1 ? args[searchIdx + 1] : null;

// --- Fetch facts ---
let factQuery = `
	  SELECT mf.id, mf.text, mf.is_static, mf.document_date, mf.event_date,
	         COALESCE(mf.abstraction_level, 1) AS abstraction_level,
	         COALESCE(mf.descendant_count, 0) AS descendant_count,
	         COUNT(fr.id) AS edge_count,
         CAST(julianday('now') - julianday(mf.created_at) AS REAL) AS age_days
  FROM memory_facts mf
  LEFT JOIN fact_relations fr ON (fr.fact_id_a = mf.id OR fr.fact_id_b = mf.id)
  WHERE mf.user_id = ? AND mf.is_latest = 1 AND mf.is_forgotten = 0
`;
const params: (string | number)[] = [userId];

if (filterStatic) { factQuery += " AND mf.is_static = 1"; }
else if (filterDynamic) { factQuery += " AND mf.is_static = 0"; }
if (searchTerm) { factQuery += " AND mf.text LIKE ?"; params.push(`%${searchTerm}%`); }

factQuery += " GROUP BY mf.id ORDER BY edge_count DESC, mf.created_at DESC";

const facts = db.prepare(factQuery).all(...params) as Array<{
	  id: number; text: string; is_static: number;
	  document_date: string; event_date: string | null;
	  abstraction_level: number; descendant_count: number;
	  edge_count: number; age_days: number;
}>;

// --- Fetch all relates_to edges ---
const edges = db.prepare(`
  SELECT fact_id_a, fact_id_b, relation_type FROM fact_relations
`).all() as Array<{ fact_id_a: number; fact_id_b: number; relation_type: string }>;

// Build adjacency: factId → [{id, type, dir}]
const adj = new Map<number, Array<{ id: number; type: string; dir: "out" | "in" | "both" }>>();
for (const e of edges) {
  if (!adj.has(e.fact_id_a)) adj.set(e.fact_id_a, []);
  if (!adj.has(e.fact_id_b)) adj.set(e.fact_id_b, []);
  if (e.relation_type === "relates_to") {
    adj.get(e.fact_id_a)!.push({ id: e.fact_id_b, type: e.relation_type, dir: "both" });
    adj.get(e.fact_id_b)!.push({ id: e.fact_id_a, type: e.relation_type, dir: "both" });
  } else {
    adj.get(e.fact_id_a)!.push({ id: e.fact_id_b, type: e.relation_type, dir: "out" });
    adj.get(e.fact_id_b)!.push({ id: e.fact_id_a, type: e.relation_type, dir: "in" });
  }
}

// Text lookup
const factText = new Map(facts.map((f) => [f.id, f.text]));

// --- Bedrock: same formula as getBedrockFacts() ---
// Level 1 only: descendant_count / (1 + age_days * 0.05)
const bedrock = [...facts]
  .filter((f) => f.abstraction_level === 1)
  .sort((a, b) => {
    const score = (f: typeof a) => f.descendant_count / (1 + f.age_days * 0.05);
    return score(b) - score(a);
  })
  .slice(0, 5);

// --- Print ---
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const GRAY = "\x1b[90m";

console.log(`\n${BOLD}ALFRED MEMORY GRAPH${RESET}  ${DIM}(${facts.length} active facts, ${edges.length} edges)${RESET}\n`);

if (!searchTerm && !filterDynamic) {
  console.log(`${BOLD}${CYAN}⬟ BEDROCK (level-1 patterns by descendant_count)${RESET}`);
  for (const f of bedrock) {
    const score = (f.descendant_count / (1 + f.age_days * 0.05)).toFixed(2);
    const tag = f.is_static ? `${GREEN}static${RESET}` : `${GRAY}dynamic${RESET}`;
    console.log(`  ${BOLD}[${f.id}]${RESET} ${f.text}`);
    console.log(`       L${f.abstraction_level} · ${tag} · ${f.descendant_count} descendants · ${f.edge_count} edges · score ${score} · ${f.document_date.slice(0, 10)}${RESET}`);
  }
  console.log();
}

console.log(`${BOLD}${YELLOW}◈ ALL FACTS${RESET}${searchTerm ? ` matching "${searchTerm}"` : ""}${filterStatic ? " (static only)" : filterDynamic ? " (dynamic only)" : ""}`);
console.log();

for (const f of facts) {
  const tag = f.is_static ? `${GREEN}static${RESET}` : `${GRAY}dynamic${RESET}`;
  const eventStr = f.event_date ? ` · event: ${f.event_date.slice(0, 10)}` : "";
  console.log(`  ${BOLD}[${f.id}]${RESET} ${f.text}`);
  console.log(`       L${f.abstraction_level} · ${tag} · ${f.descendant_count} descendants · ${f.edge_count} edges · ${f.document_date.slice(0, 10)}${eventStr}`);

  const neighbors = adj.get(f.id) ?? [];
  if (neighbors.length > 0) {
    for (const n of neighbors) {
      const nText = factText.get(n.id) ?? `fact_${n.id}`;
      const typeStr = n.type === "relates_to"
        ? "~"
        : n.dir === "out"
          ? `${n.type} ->`
          : `<- ${n.type}`;
      console.log(`       ${DIM}${typeStr} [${n.id}] ${nText.slice(0, 80)}${RESET}`);
    }
  }
  console.log();
}

db.close();
