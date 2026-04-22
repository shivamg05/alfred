import {
  getFactById,
  getMessageById,
  getActiveDynamicFacts,
  getStaticProfileFacts,
  getDynamicProfileFacts,
  searchFactsFTS,
} from "./facts.js";
import { querySimilarFacts } from "./vectors.js";

export interface RetrievedContext {
  staticProfile: string[];
  dynamicProfile: string[];
  relevantFacts: string[];
}

const RECENCY_HALFLIFE_DAYS = 30;
const RRF_K = 60; // standard RRF constant

function recencyWeight(documentDate: string): number {
  const ageMs = Date.now() - new Date(documentDate).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.exp((-Math.log(2) * ageDays) / RECENCY_HALFLIFE_DAYS);
}

/**
 * Reciprocal Rank Fusion — merges ranked lists from multiple retrieval
 * strategies into a single score. Standard formula: 1/(k + rank).
 */
function rrf(rankMaps: Map<number, number>[]): Map<number, number> {
  const scores = new Map<number, number>();
  for (const rankMap of rankMaps) {
    for (const [factId, rank] of rankMap) {
      scores.set(factId, (scores.get(factId) ?? 0) + 1 / (RRF_K + rank));
    }
  }
  return scores;
}

/**
 * Format a retrieved fact with its source chunk for context richness.
 * Supermemory insight: the atomic fact gives precision for retrieval;
 * the source snippet gives nuance for the LLM to reason from.
 */
function formatWithSourceChunk(factText: string, sourceMessageId?: number): string {
  if (!sourceMessageId) return factText;
  try {
    const msg = getMessageById(sourceMessageId);
    if (!msg) return factText;
    const rawText = msg.transcript ?? msg.raw_text ?? null;
    if (!rawText || rawText.trim() === factText.trim()) return factText;
    const snippet = rawText.slice(0, 180).replace(/\n/g, " ");
    return `${factText} (from: "${snippet}${rawText.length > 180 ? "…" : ""}")`;
  } catch {
    return factText;
  }
}

export async function retrieveContext(queryText: string): Promise<RetrievedContext> {
  const staticProfile = getStaticProfileFacts();
  const dynamicProfile = getDynamicProfileFacts();

  let relevantFacts: string[] = [];

  // --- Strategy 1: Semantic search (ChromaDB) ---
  let semanticRankMap = new Map<number, number>();
  try {
    const hits = await querySimilarFacts(queryText, 15);
    hits.forEach((h, i) => {
      if (h.factId > 0) semanticRankMap.set(h.factId, i + 1);
    });
  } catch {
    // ChromaDB not ready — will fall back to FTS + profile
  }

  // --- Strategy 2: BM25 keyword search (SQLite FTS5) ---
  const ftsHits = searchFactsFTS(queryText, 15);
  const ftsRankMap = new Map<number, number>();
  ftsHits.forEach((h, i) => ftsRankMap.set(h.id, i + 1));

  // --- RRF merge ---
  const merged = rrf([semanticRankMap, ftsRankMap]);

  if (merged.size > 0) {
    // Sort by RRF score descending, then apply recency + static boost
    const candidates = Array.from(merged.entries())
      .map(([factId, rrfScore]) => {
        const fact = getFactById(factId);
        if (!fact) return null;
        const recency = recencyWeight(fact.document_date);
        const staticBoost = fact.is_static ? 0.15 : 0;
        // RRF already blends retrieval strategies; add lightweight re-rank
        const finalScore = rrfScore + recency * 0.1 + staticBoost;
        return { fact, finalScore };
      })
      .filter(Boolean) as Array<{ fact: NonNullable<ReturnType<typeof getFactById>>; finalScore: number }>;

    candidates.sort((a, b) => b.finalScore - a.finalScore);

    relevantFacts = candidates.slice(0, 6).map(({ fact }) =>
      formatWithSourceChunk(fact.text, fact.source_message_id),
    );
  } else {
    // Nothing in ChromaDB or FTS — fall back to recent dynamic facts
    const fallback = getActiveDynamicFacts().slice(0, 6);
    relevantFacts = fallback.map((f) =>
      formatWithSourceChunk(f.text, f.source_message_id),
    );
  }

  return { staticProfile, dynamicProfile, relevantFacts };
}
