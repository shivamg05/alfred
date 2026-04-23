import {
  getFactById,
  getMessageById,
  getActiveDynamicFacts,
  getBedrockFacts,
  getRelatedFactIds,
  searchFactsFTS,
} from "./facts.js";
import { querySimilarFacts } from "./vectors.js";

export interface RetrievedContext {
  /** 5 foundational static facts — always in every context window */
  bedrock: string[];
  /** Up to 14 facts retrieved for this specific message + graph-expanded neighbors */
  retrieved: string[];
}

const RECENCY_HALFLIFE_DAYS = 30;
const RRF_K = 60;

function recencyWeight(documentDate: string): number {
  const ageMs = Date.now() - new Date(documentDate).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.exp((-Math.log(2) * ageDays) / RECENCY_HALFLIFE_DAYS);
}

function rrf(rankMaps: Map<number, number>[]): Map<number, number> {
  const scores = new Map<number, number>();
  for (const rankMap of rankMaps) {
    for (const [factId, rank] of rankMap) {
      scores.set(factId, (scores.get(factId) ?? 0) + 1 / (RRF_K + rank));
    }
  }
  return scores;
}

function formatWithSourceChunk(factText: string, sourceMessageId?: number): string {
  if (!sourceMessageId) return factText;
  try {
    const msg = getMessageById(sourceMessageId);
    if (!msg) return factText;
    const rawText = msg.transcript ?? msg.raw_text ?? null;
    if (!rawText || rawText.trim() === factText.trim()) return factText;
    const snippet = rawText.slice(0, 150).replace(/\n/g, " ");
    return `${factText} (from: "${snippet}${rawText.length > 150 ? "…" : ""}")`;
  } catch {
    return factText;
  }
}

export async function retrieveContext(queryText: string): Promise<RetrievedContext> {
  // --- Bedrock: always-on core identity (5 oldest static facts) ---
  const bedrockFacts = getBedrockFacts();
  const bedrock = bedrockFacts.map((f) => f.text);
  const bedrockIds = new Set(bedrockFacts.map((f) => f.id));
  const bedrockTextSet = new Set(bedrock);

  // --- Hybrid retrieval across ALL active facts ---
  const t0 = Date.now();
  let semanticRankMap = new Map<number, number>();
  try {
    const hits = await querySimilarFacts(queryText, 20);
    hits.forEach((h, i) => {
      if (h.factId > 0) semanticRankMap.set(h.factId, i + 1);
    });
  } catch {
    // ChromaDB not ready — FTS will carry retrieval
  }
  const tSemantic = Date.now();

  const ftsHits = searchFactsFTS(queryText, 20);
  const tFTS = Date.now();
  const ftsRankMap = new Map<number, number>();
  ftsHits.forEach((h, i) => ftsRankMap.set(h.id, i + 1));

  const merged = rrf([semanticRankMap, ftsRankMap]);

  let retrieved: string[] = [];

  if (merged.size > 0) {
    // Score, filter, and rank all candidates
    const candidates = Array.from(merged.entries())
      .map(([factId, rrfScore]) => {
        if (bedrockIds.has(factId)) return null;
        const fact = getFactById(factId);
        if (!fact || !fact.is_latest || fact.is_forgotten) return null;
        const recency = recencyWeight(fact.document_date);
        const staticBoost = fact.is_static ? 0.1 : 0;
        // Upcoming events get a boost so they surface for scheduling context
        const upcomingBoost =
          fact.event_date && new Date(fact.event_date) > new Date() ? 0.15 : 0;
        return { fact, finalScore: rrfScore + recency * 0.1 + staticBoost + upcomingBoost };
      })
      .filter(Boolean) as Array<{
        fact: NonNullable<ReturnType<typeof getFactById>>;
        finalScore: number;
      }>;

    candidates.sort((a, b) => b.finalScore - a.finalScore);
    const top10 = candidates.slice(0, 10);
    const retrievedIds = new Set(top10.map(({ fact }) => fact.id));

    // --- Graph expansion: follow relates_to edges from top 5 hits ---
    const expansionLines: string[] = [];
    for (const { fact } of top10.slice(0, 5)) {
      if (expansionLines.length >= 4) break;
      const relatedIds = getRelatedFactIds(fact.id);
      for (const relId of relatedIds) {
        if (expansionLines.length >= 4) break;
        if (retrievedIds.has(relId) || bedrockIds.has(relId)) continue;
        const f = getFactById(relId);
        if (!f || !f.is_latest || f.is_forgotten || bedrockTextSet.has(f.text)) continue;
        console.log(`[retrieval] graph expand: fact_${fact.id} → fact_${relId} "${f.text.slice(0, 60)}"`);
        expansionLines.push(formatWithSourceChunk(f.text, f.source_message_id));
        retrievedIds.add(relId);
      }
    }

    retrieved = [
      ...top10.map(({ fact }) => formatWithSourceChunk(fact.text, fact.source_message_id)),
      ...expansionLines,
    ];
  } else {
    // Cold start fallback: no ChromaDB yet — pull recent dynamic facts
    retrieved = getActiveDynamicFacts()
      .filter((f) => !bedrockTextSet.has(f.text))
      .slice(0, 12)
      .map((f) => formatWithSourceChunk(f.text, f.source_message_id));
  }

  const tDone = Date.now();
  console.log(`[retrieval] timings — semantic:${tSemantic - t0}ms fts:${tFTS - tSemantic}ms rank+expand:${tDone - tFTS}ms total:${tDone - t0}ms`);
  console.log(
    `[retrieval] bedrock(${bedrockFacts.length}): ` +
    bedrockFacts.map((f) => `"${f.text.slice(0, 40)}" (${f.edge_count ?? 0} edges)`).join(", "),
  );
  console.log(
    `[retrieval] retrieved(${retrieved.length}): ` +
    retrieved.map((f) => `"${f.slice(0, 50)}"`).join(" | "),
  );

  return { bedrock, retrieved };
}
