import { ChromaClient, Collection, EmbeddingFunction } from "chromadb";
import OpenAI from "openai";
import { config } from "../config.js";

// Use OpenAI embeddings directly so ChromaDB doesn't try to load its default embed package.
// If LLM_BASE_URL is set (e.g. OpenRouter), route embeddings through it too — the key is
// an OpenRouter key and won't work against api.openai.com directly.
// OpenRouter supports text-embedding-3-small at openai/text-embedding-3-small.
class OpenAIEmbeddings implements EmbeddingFunction {
  private client: OpenAI;

  constructor() {
    const cfg = config();
    this.client = new OpenAI({
      apiKey: cfg.OPENAI_API_KEY,
      ...(cfg.LLM_BASE_URL ? { baseURL: cfg.LLM_BASE_URL } : {}),
    });
  }

  async generate(texts: string[]): Promise<number[][]> {
    const cfg = config();
    // OpenRouter uses namespaced model IDs; OpenAI uses bare names.
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

export async function upsertFact(factId: number, text: string, metadata: Record<string, string | number | boolean>): Promise<string> {
  const collection = await factsCollection();
  const id = `fact_${factId}`;
  await collection.upsert({
    ids: [id],
    documents: [text],
    metadatas: [metadata],
  });
  return id;
}

export interface SemanticHit {
  factId: number;
  text: string;
  distance: number;
  metadata: Record<string, unknown>;
}

export async function querySimilarFacts(
  queryText: string,
  n = 10,
): Promise<SemanticHit[]> {
  const collection = await factsCollection();
  const results = await collection.query({
    queryTexts: [queryText],
    nResults: n,
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
