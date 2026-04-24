import { ChromaClient, Collection, EmbeddingFunction } from "chromadb";
import OpenAI from "openai";
import { config } from "../config.js";
import { makeOpenAIClient } from "../orchestrator/llm.js";

// Use OpenAI embeddings directly so ChromaDB doesn't try to load its default embed package.
// Routes through LLM_BASE_URL (OpenRouter) when set, with proper headers.
class OpenAIEmbeddings implements EmbeddingFunction {
  private client: OpenAI;

  constructor() {
    this.client = makeOpenAIClient();
  }

  async generate(texts: string[]): Promise<number[][]> {
    const cfg = config();
    const model = cfg.LLM_BASE_URL ? "openai/text-embedding-3-small" : "text-embedding-3-small";
    const response = await this.client.embeddings.create({ model, input: texts });
    return response.data.map((d) => d.embedding);
  }
}

let _embedder: OpenAIEmbeddings | null = null;
function embedder(): OpenAIEmbeddings {
  if (!_embedder) _embedder = new OpenAIEmbeddings();
  return _embedder;
}

let _client: ChromaClient | null = null;
let _collection: Collection | null = null;

export function chromaClient(): ChromaClient {
  if (!_client) {
    _client = new ChromaClient({ host: "localhost", port: config().CHROMA_PORT });
  }
  return _client;
}

export async function factsCollection(): Promise<Collection> {
  if (!_collection) {
    _collection = await chromaClient().getOrCreateCollection({
      name: "alfred_facts",
      metadata: { "hnsw:space": "cosine" },
      embeddingFunction: embedder(),
    });
  }
  return _collection;
}

export async function upsertFact(
  factId: number,
  text: string,
  metadata: Record<string, string | number | boolean>,
): Promise<string> {
  const collection = await factsCollection();
  const id = `fact_${factId}`;
  await collection.upsert({
    ids: [id],
    documents: [text],
    metadatas: [metadata],
  });
  return id;
}

/**
 * On startup: find any facts with chroma_id IS NULL and embed them.
 * These exist when ChromaDB was down during extraction — facts were saved to
 * SQLite but the embedding call failed silently.
 */
export async function embedUnindexedFacts(): Promise<void> {
  const { db } = await import("../db/schema.js");
  const { config: cfg } = await import("../config.js");
  const userId = cfg().USER_ID;

  const unindexed = db()
    .prepare(
      `SELECT id, text, is_static, document_date, event_date,
              COALESCE(abstraction_level, 1) AS abstraction_level
       FROM memory_facts
       WHERE user_id = ? AND is_latest = 1 AND is_forgotten = 0
         AND (chroma_id IS NULL OR chroma_id = '')
       ORDER BY id ASC`,
    )
    .all(userId) as Array<{
      id: number; text: string; is_static: number;
      document_date: string; event_date: string | null;
      abstraction_level: number;
    }>;

  if (unindexed.length === 0) return;
  console.log(`[vectors] embedding ${unindexed.length} unindexed fact(s)...`);

  const collection = await factsCollection();
  const BATCH = 20;

  for (let i = 0; i < unindexed.length; i += BATCH) {
    const batch = unindexed.slice(i, i + BATCH);
    try {
      const embeddings = await embedder().generate(batch.map((f) => f.text));
      await collection.upsert({
        ids: batch.map((f) => `fact_${f.id}`),
        embeddings,
        documents: batch.map((f) => f.text),
        metadatas: batch.map((f) => ({
          is_static: f.is_static === 1,
          abstraction_level: f.abstraction_level,
          document_date: f.document_date,
          user_id: userId,
          ...(f.event_date ? { event_date: f.event_date } : {}),
        })),
      });
      for (const f of batch) {
        db().prepare("UPDATE memory_facts SET chroma_id = ? WHERE id = ?").run(`fact_${f.id}`, f.id);
      }
      console.log(`[vectors] indexed facts ${batch[0].id}–${batch[batch.length - 1].id}`);
    } catch (err) {
      console.error(`[vectors] batch embed failed:`, err);
    }
  }
}

export interface SemanticHit {
  factId: number;
  text: string;
  distance: number;
  metadata: Record<string, unknown>;
}

/**
 * Query ChromaDB for semantically similar facts.
 *
 * @param queryText  - Text to embed and search against
 * @param n          - Max results to return (ChromaDB may return fewer when filtering)
 * @param whereFilter - Optional metadata filter, e.g. { abstraction_level: 1 }
 *                      Uses ChromaDB's $eq operator internally.
 */
export async function querySimilarFacts(
  queryText: string,
  n = 10,
  whereFilter?: Partial<Record<string, string | number | boolean>>,
): Promise<SemanticHit[]> {
  const collection = await factsCollection();

  // Build ChromaDB where clause from simple key/value pairs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let where: Record<string, any> | undefined;
  if (whereFilter && Object.keys(whereFilter).length > 0) {
    const conditions = Object.entries(whereFilter).map(([key, value]) => ({
      [key]: { $eq: value },
    }));
    where = conditions.length === 1 ? conditions[0] : { $and: conditions };
  }

  const results = await collection.query({
    queryTexts: [queryText],
    nResults: n,
    ...(where ? { where } : {}),
  });

  const ids = results.ids[0] ?? [];
  const documents = results.documents[0] ?? [];
  const distances = results.distances?.[0] ?? [];
  const metadatas = results.metadatas?.[0] ?? [];

  return ids.map((id, i) => ({
    factId: parseInt((id as string).replace("fact_", ""), 10),
    text: (documents[i] as string) ?? "",
    distance: (distances[i] as number) ?? 1,
    metadata: (metadatas[i] as Record<string, unknown>) ?? {},
  }));
}
