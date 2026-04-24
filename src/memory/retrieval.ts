import {
  getFactById,
  getMessageById,
  getActiveDynamicFacts,
  getBedrockFacts,
  getLevel2Facts,
  getInstanceOfParents,
  getRelatedFactIds,
  searchFactsFTS,
} from "./facts.js";
import { querySimilarFacts } from "./vectors.js";

export interface RetrievedContext {
  /** Level 2 identity/value facts — always in every context window */
  identity: string[];
  /** Top Level 1 patterns by descendant_count — always in every context window */
  bedrock: string[];
  /** Query-specific facts plus upward/lateral graph expansion */
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
  // --- Always-on memory layers ---
  const identityFacts = getLevel2Facts().slice(0, 10);
  const identity = identityFacts.map((f) => f.text);
  const bedrockFacts = getBedrockFacts();
  const bedrock = bedrockFacts.map((f) => f.text);
  const alwaysIds = new Set([...identityFacts, ...bedrockFacts].map((f) => f.id));
  const alwaysTextSet = new Set([...identity, ...bedrock]);

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
        if (alwaysIds.has(factId)) return null;
        const fact = getFactById(factId);
        if (!fact || !fact.is_latest || fact.is_forgotten) return null;
        const recency = recencyWeight(fact.document_date);
        const levelRecencyScale = Math.max(0, 1 - fact.abstraction_level / 2);
        const staticBoost = fact.is_static ? 0.1 : 0;
        // Upcoming events get a boost so they surface for scheduling context
        const upcomingBoost =
          fact.event_date && new Date(fact.event_date) > new Date() ? 0.15 : 0;
        return {
          fact,
          finalScore: rrfScore + recency * 0.1 * levelRecencyScale + staticBoost + upcomingBoost,
        };
      })
      .filter(Boolean) as Array<{
        fact: NonNullable<ReturnType<typeof getFactById>>;
        finalScore: number;
      }>;

    candidates.sort((a, b) => b.finalScore - a.finalScore);
    const top10 = candidates.slice(0, 10);
    const retrievedIds = new Set(top10.map(({ fact }) => fact.id));
    const seenText = new Set(alwaysTextSet);

    // --- Upward expansion: follow instance_of parents for meaning/context ---
    const expansionLines: string[] = [];
    for (const { fact } of top10.slice(0, 6)) {
      if (expansionLines.length >= 5) break;
      const stack = getInstanceOfParents(fact.id).map((id) => ({ id, depth: 1 }));
      const visited = new Set<number>();
      while (stack.length > 0 && expansionLines.length < 5) {
        const item = stack.shift();
        if (!item || item.depth > 2 || visited.has(item.id)) continue;
        visited.add(item.id);
        if (retrievedIds.has(item.id) || alwaysIds.has(item.id)) continue;
        const parent = getFactById(item.id);
        if (!parent || !parent.is_latest || parent.is_forgotten || seenText.has(parent.text)) continue;
        console.log(`[retrieval] upward expand: fact_${fact.id} -> fact_${parent.id} "${parent.text.slice(0, 60)}"`);
        expansionLines.push(parent.text);
        retrievedIds.add(parent.id);
        seenText.add(parent.text);
        for (const grandparentId of getInstanceOfParents(parent.id)) {
          stack.push({ id: grandparentId, depth: item.depth + 1 });
        }
      }
    }

    // --- Lateral expansion: limited relates_to hop after upward context ---
    for (const { fact } of top10.slice(0, 5)) {
      if (expansionLines.length >= 5) break;
      const relatedIds = getRelatedFactIds(fact.id);
      for (const relId of relatedIds) {
        if (expansionLines.length >= 5) break;
        if (retrievedIds.has(relId) || alwaysIds.has(relId)) continue;
        const f = getFactById(relId);
        if (!f || !f.is_latest || f.is_forgotten || alwaysTextSet.has(f.text) || seenText.has(f.text)) continue;
        console.log(`[retrieval] graph expand: fact_${fact.id} → fact_${relId} "${f.text.slice(0, 60)}"`);
        expansionLines.push(f.text);
        retrievedIds.add(relId);
        seenText.add(f.text);
      }
    }

    retrieved = [
      ...top10.map(({ fact }) => {
        seenText.add(fact.text);
        return fact.text;
      }),
      ...expansionLines,
    ];
  } else {
    // Cold start fallback: no ChromaDB yet — pull recent dynamic facts
    retrieved = getActiveDynamicFacts()
      .filter((f) => !alwaysTextSet.has(f.text))
      .slice(0, 12)
      .map((f) => f.text);
  }

  const tDone = Date.now();
  console.log(`[retrieval] timings — semantic:${tSemantic - t0}ms fts:${tFTS - tSemantic}ms rank+expand:${tDone - tFTS}ms total:${tDone - t0}ms`);
  console.log(
    `[retrieval] identity(${identityFacts.length}): ` +
    identityFacts.map((f) => `"${f.text.slice(0, 40)}" (${f.descendant_count} desc)`).join(", "),
  );
  console.log(
    `[retrieval] bedrock(${bedrockFacts.length}): ` +
    bedrockFacts.map((f) => `"${f.text.slice(0, 40)}" (${f.descendant_count} desc)`).join(", "),
  );
  console.log(
    `[retrieval] retrieved(${retrieved.length}): ` +
    retrieved.map((f) => `"${f.slice(0, 50)}"`).join(" | "),
  );

  return { identity, bedrock, retrieved };
}
