import { getFactById, insertRelation, markSuperseded } from "./facts.js";
import { querySimilarFacts } from "./vectors.js";

const CONTRADICTION_THRESHOLD = 0.80;

export async function resolveContradiction(
  newFactId: number,
  contradictHint: string,
): Promise<void> {
  const hits = await querySimilarFacts(contradictHint, 3);

  for (const hit of hits) {
    if (1 - hit.distance >= CONTRADICTION_THRESHOLD && hit.factId !== newFactId) {
      const existing = getFactById(hit.factId);
      if (!existing) continue;

      insertRelation(newFactId, hit.factId, "updates");
      markSuperseded(hit.factId, newFactId, { rewireChildren: false });

      console.log(`[resolver] fact ${newFactId} supersedes fact ${hit.factId}: "${existing.text}"`);
      break;
    }
  }
}
