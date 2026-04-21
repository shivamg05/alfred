import { getFactById, getActiveDynamicFacts, getStaticProfileFacts, getDynamicProfileFacts } from "./facts.js";
import { querySimilarFacts } from "./vectors.js";

export interface RetrievedContext {
  staticProfile: string[];
  dynamicProfile: string[];
  relevantFacts: string[];
}

const RECENCY_HALFLIFE_DAYS = 30;

function recencyWeight(documentDate: string): number {
  const ageMs = Date.now() - new Date(documentDate).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.exp((-Math.log(2) * ageDays) / RECENCY_HALFLIFE_DAYS);
}

export async function retrieveContext(queryText: string): Promise<RetrievedContext> {
  const staticProfile = getStaticProfileFacts();
  const dynamicProfile = getDynamicProfileFacts();

  let relevantFacts: string[] = [];

  try {
    const hits = await querySimilarFacts(queryText, 10);

    const scored = hits
      .filter((h) => h.factId > 0)
      .map((h) => {
        const fact = getFactById(h.factId);
        if (!fact) return null;
        const semantic = 1 - h.distance;          // convert distance to similarity
        const recency = recencyWeight(fact.document_date);
        const staticBoost = fact.is_static ? 0.2 : 0;
        const score = semantic * 0.5 + recency * 0.3 + staticBoost;
        return { text: fact.text, score };
      })
      .filter(Boolean) as Array<{ text: string; score: number }>;

    scored.sort((a, b) => b.score - a.score);
    relevantFacts = scored.slice(0, 5).map((s) => s.text);
  } catch {
    // ChromaDB may not be ready yet; fall back to recent dynamic facts
    const fallback = getActiveDynamicFacts().slice(0, 5);
    relevantFacts = fallback.map((f) => f.text);
  }

  return { staticProfile, dynamicProfile, relevantFacts };
}
