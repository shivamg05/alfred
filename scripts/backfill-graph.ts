/**
 * Two-pass backfill:
 *   1. Embed any facts missing from ChromaDB (chroma_id IS NULL)
 *   2. Wire relates_to edges for all facts based on semantic distance
 *
 * Usage: pnpm backfill-graph
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

import Database from "better-sqlite3";
import { ChromaClient } from "chromadb";
import OpenAI from "openai";
import { config } from "../src/config.js";

const cfg = config();
const db = new Database(cfg.DB_PATH);
const userId = cfg.USER_ID ?? "local";

const openai = new OpenAI({
  apiKey: cfg.OPENAI_API_KEY,
  ...(cfg.LLM_BASE_URL ? { baseURL: cfg.LLM_BASE_URL } : {}),
});

const embeddingModel = cfg.LLM_BASE_URL
  ? "openai/text-embedding-3-small"
  : "text-embedding-3-small";

async function embed(texts: string[]): Promise<number[][]> {
  const res = await openai.embeddings.create({ model: embeddingModel, input: texts });
  return res.data.map((d) => d.embedding);
}

const chroma = new ChromaClient({ host: "localhost", port: cfg.CHROMA_PORT });
const collection = await chroma.getOrCreateCollection({
  name: "alfred_facts",
  metadata: { "hnsw:space": "cosine" },
});

// --- Pass 1: embed facts that aren't in ChromaDB yet ---
const unembedded = db.prepare(`
  SELECT id, text, is_static, document_date, event_date
  FROM memory_facts
  WHERE user_id = ? AND is_latest = 1 AND is_forgotten = 0
    AND (chroma_id IS NULL OR chroma_id = '')
  ORDER BY id ASC
`).all(userId) as { id: number; text: string; is_static: number; document_date: string; event_date: string | null }[];

console.log(`[backfill] pass 1: embedding ${unembedded.length} facts missing from ChromaDB`);

const BATCH = 20;
const setChromaId = db.prepare("UPDATE memory_facts SET chroma_id = ? WHERE id = ?");

for (let i = 0; i < unembedded.length; i += BATCH) {
  const batch = unembedded.slice(i, i + BATCH);
  try {
    const embeddings = await embed(batch.map((f) => f.text));
    await collection.upsert({
      ids: batch.map((f) => `fact_${f.id}`),
      embeddings,
      documents: batch.map((f) => f.text),
      metadatas: batch.map((f) => ({
        is_static: f.is_static === 1,
        document_date: f.document_date,
        ...(f.event_date ? { event_date: f.event_date } : {}),
        user_id: userId,
      })),
    });
    for (const f of batch) {
      setChromaId.run(`fact_${f.id}`, f.id);
    }
    console.log(`  embedded ${Math.min(i + BATCH, unembedded.length)}/${unembedded.length}`);
  } catch (err) {
    console.error(`  batch ${i}–${i + BATCH} failed:`, err);
  }
}

// --- Pass 2: wire relates_to edges ---
const allFacts = db.prepare(`
  SELECT id, text FROM memory_facts
  WHERE user_id = ? AND is_latest = 1 AND is_forgotten = 0
  ORDER BY id ASC
`).all(userId) as { id: number; text: string }[];

console.log(`\n[backfill] pass 2: wiring edges for ${allFacts.length} facts`);

const insertEdge = db.prepare(`
  INSERT OR IGNORE INTO fact_relations (fact_id_a, fact_id_b, relation_type)
  VALUES (?, ?, 'relates_to')
`);

let edgesAdded = 0;
const n = Math.min(allFacts.length, 50); // ChromaDB nResults cap

for (let i = 0; i < allFacts.length; i++) {
  const fact = allFacts[i];
  try {
    const [vector] = await embed([fact.text]);
    const results = await collection.query({
      queryEmbeddings: [vector],
      nResults: n,
    });

    const ids = results.ids[0] ?? [];
    const distances = results.distances?.[0] ?? [];

    for (let j = 0; j < ids.length; j++) {
      const otherId = parseInt((ids[j] as string).replace("fact_", ""), 10);
      const dist = distances[j] as number;
      if (otherId === fact.id || isNaN(otherId)) continue;
      if (dist < 0.12 || dist > 0.55) continue;
      const res = insertEdge.run(fact.id, otherId);
      if (res.changes > 0) edgesAdded++;
    }
  } catch (err) {
    console.error(`  fact_${fact.id} query failed:`, err);
  }
  process.stdout.write(`\r  ${i + 1}/${allFacts.length} facts processed, ${edgesAdded} edges added`);
}

console.log(`\n[backfill] done — ${edgesAdded} total edges wired`);
db.close();
