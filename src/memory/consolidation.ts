import { z } from "zod";
import { config } from "../config.js";
import { makeOpenAIClient } from "../orchestrator/llm.js";
import {
  MemoryFact,
  getExpiredLevel0Facts,
  getFactById,
  getFactsByLevel,
  insertFact,
  insertInstanceOfRelation,
  insertRelation,
  markForgotten,
  markSuperseded,
  updateChromaId,
} from "./facts.js";
import { querySimilarFacts, upsertFact as chromaUpsert } from "./vectors.js";

const summarySchema = z.object({
  should_consolidate: z.boolean(),
  text: z.string().optional(),
});

const identitySchema = z.object({
  should_promote: z.boolean(),
  text: z.string().optional(),
});

function extractJSON(s: string): string {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return s.slice(start, end + 1);
  return s.trim();
}

async function clusterFacts(facts: MemoryFact[], maxDistance: number): Promise<MemoryFact[][]> {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const assigned = new Set<number>();
  const clusters: MemoryFact[][] = [];

  for (const fact of facts) {
    if (assigned.has(fact.id)) continue;
    const cluster = [fact];
    assigned.add(fact.id);
    try {
      const hits = await querySimilarFacts(fact.text, 10, { abstraction_level: fact.abstraction_level });
      for (const hit of hits) {
        if (hit.factId === fact.id || hit.distance > maxDistance || assigned.has(hit.factId)) continue;
        const candidate = byId.get(hit.factId);
        if (!candidate) continue;
        cluster.push(candidate);
        assigned.add(candidate.id);
      }
    } catch {
      // ChromaDB unavailable: leave as singleton and let caller decide.
    }
    clusters.push(cluster);
  }

  return clusters;
}

async function summarizeLevel0Cluster(cluster: MemoryFact[]): Promise<string | null> {
  const response = await makeOpenAIClient().chat.completions.create({
    model: config().EXTRACTION_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You consolidate expiring level-0 memory facts into one durable level-1 behavioral pattern only if the facts support a real pattern. Return raw JSON: {\"should_consolidate\": boolean, \"text\": \"User ...\"}. If they are just isolated events, set should_consolidate false.",
      },
      { role: "user", content: cluster.map((f) => `- ${f.text}`).join("\n") },
    ],
    max_tokens: 250,
    response_format: { type: "json_object" },
  });
  const raw = response.choices[0]?.message?.content ?? "{}";
  const parsed = summarySchema.parse(JSON.parse(extractJSON(raw)));
  if (!parsed.should_consolidate || !parsed.text?.trim()) return null;
  return parsed.text.trim();
}

async function summarizeLevel1Cluster(cluster: MemoryFact[]): Promise<string | null> {
  const response = await makeOpenAIClient().chat.completions.create({
    model: config().EXTRACTION_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You promote level-1 behavioral patterns into one level-2 identity/value fact only when the cluster reveals a durable self-model or value. Be conservative. Return raw JSON: {\"should_promote\": boolean, \"text\": \"User ...\"}.",
      },
      { role: "user", content: cluster.map((f) => `- ${f.text}`).join("\n") },
    ],
    max_tokens: 250,
    response_format: { type: "json_object" },
  });
  const raw = response.choices[0]?.message?.content ?? "{}";
  const parsed = identitySchema.parse(JSON.parse(extractJSON(raw)));
  if (!parsed.should_promote || !parsed.text?.trim()) return null;
  return parsed.text.trim();
}

async function findExistingParent(text: string, level: 1 | 2): Promise<MemoryFact | null> {
  try {
    const hits = await querySimilarFacts(text, 5, { abstraction_level: level });
    for (const hit of hits) {
      if (hit.distance > 0.25) continue;
      const fact = getFactById(hit.factId);
      if (!fact || !fact.is_latest || fact.is_forgotten || fact.abstraction_level !== level) continue;
      return fact;
    }
  } catch {
    // ChromaDB unavailable; caller will create a fresh parent.
  }
  return null;
}

async function insertConsolidatedFact(text: string, level: 1 | 2, documentDate: string): Promise<number> {
  const factId = insertFact({
    text,
    is_static: false,
    abstraction_level: level,
    document_date: documentDate,
  });
  try {
    const chromaId = await chromaUpsert(factId, text, {
      is_static: false,
      abstraction_level: level,
      document_date: documentDate,
      user_id: config().USER_ID,
    });
    updateChromaId(factId, chromaId);
  } catch (err) {
    console.error(`[consolidation] ChromaDB upsert failed for fact_${factId}:`, err);
  }
  return factId;
}

export async function consolidateExpiredLevel0(): Promise<void> {
  const candidates = getExpiredLevel0Facts(80);
  if (candidates.length === 0) return;
  console.log(`[consolidation] scanning ${candidates.length} expired L0 fact(s)`);

  const clusters = await clusterFacts(candidates, 0.35);
  for (const cluster of clusters) {
    if (cluster.length < 2) {
      markForgotten(cluster[0].id);
      console.log(`[consolidation] forgot singleton fact_${cluster[0].id}: "${cluster[0].text.slice(0, 70)}"`);
      continue;
    }

    let summary: string | null = null;
    try {
      summary = await summarizeLevel0Cluster(cluster);
    } catch (err) {
      console.error("[consolidation] L0 summarization failed:", err);
    }

    if (!summary) {
      for (const fact of cluster) markForgotten(fact.id);
      console.log(`[consolidation] cluster not durable; forgot ${cluster.length} fact(s)`);
      continue;
    }

    const existing = await findExistingParent(summary, 1);
    const parentId = await insertConsolidatedFact(summary, 1, new Date().toISOString());
    if (existing) {
      insertRelation(parentId, existing.id, "updates");
      markSuperseded(existing.id, parentId, { rewireChildren: false });
      console.log(`[consolidation] updated L1 fact_${existing.id} -> fact_${parentId}`);
    } else {
      console.log(`[consolidation] created L1 fact_${parentId}: "${summary.slice(0, 90)}"`);
    }

    for (const source of cluster) {
      insertRelation(parentId, source.id, "consolidated_from");
      insertInstanceOfRelation(source.id, parentId);
      markSuperseded(source.id, parentId, { inheritParents: false });
    }
    console.log(`[consolidation] consolidated ${cluster.length} L0 fact(s) into fact_${parentId}`);
  }
}

export async function promoteLevel1Patterns(): Promise<void> {
  const candidates = getFactsByLevel(1, 100).filter((f) => f.descendant_count > 0);
  if (candidates.length < 3) return;
  console.log(`[consolidation] scanning ${candidates.length} L1 pattern fact(s)`);

  const clusters = (await clusterFacts(candidates, 0.25)).filter((cluster) => cluster.length >= 3);
  for (const cluster of clusters) {
    let summary: string | null = null;
    try {
      summary = await summarizeLevel1Cluster(cluster);
    } catch (err) {
      console.error("[consolidation] L1 promotion failed:", err);
    }
    if (!summary) continue;

    const existing = await findExistingParent(summary, 2);
    const parentId = await insertConsolidatedFact(summary, 2, new Date().toISOString());
    if (existing) {
      insertRelation(parentId, existing.id, "updates");
      markSuperseded(existing.id, parentId, { rewireChildren: false });
      console.log(`[consolidation] updated L2 fact_${existing.id} -> fact_${parentId}`);
    } else {
      console.log(`[consolidation] created L2 fact_${parentId}: "${summary.slice(0, 90)}"`);
    }

    for (const source of cluster) {
      insertRelation(parentId, source.id, "consolidated_from");
      insertInstanceOfRelation(source.id, parentId);
    }
    console.log(`[consolidation] promoted ${cluster.length} L1 fact(s) into fact_${parentId}`);
  }
}
