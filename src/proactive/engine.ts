import cron from "node-cron";
import type { IMessageSDK } from "@photon-ai/imessage-kit";
import {
  getDueReminders,
  getStrictlyDueReminders,
  markReminderFired,
  getUpcomingEventFacts,
  logProactive,
  logProactiveAttempt,
  getNudgeDueFacts,
  markNudgeFired,
  getQueuedPatternFacts,
  clearAllPatternObservationQueued,
  getStaleBedrock,
  getLevel2Facts,
  getBedrockFacts,
  getCronLastRan,
  setCronLastRan,
  insertMessage,
} from "../memory/facts.js";
import { db } from "../db/schema.js";
import { evaluateProactiveGate } from "./gate.js";
import { judgeProactiveMessage, JUDGE_THRESHOLD } from "./judge.js";
import { sendBubbles } from "../orchestrator/response.js";
import { chat, makeOpenAIClient } from "../orchestrator/llm.js";
import { fetchContext, buildPrompt } from "../orchestrator/context.js";
import { ConversationBuffer } from "../memory/shortTerm.js";
import { consolidateExpiredLevel0, promoteLevel1Patterns } from "../memory/consolidation.js";
import { searchWeb } from "../tools/web.js";
import { config } from "../config.js";

/** Strip markdown code fences that some models add despite response_format: json_object. */
function stripJsonFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

// Module-level reference to the global conversation buffer.
// Set once in registerCronJobs so all proactive paths can persist messages.
let globalBuffer: ConversationBuffer | null = null;

/**
 * Send a proactive message AND persist it in the messages table + conversation buffer.
 * This ensures that if the user replies to a proactive message, Alfred has context
 * about what it said.
 */
async function sendAndPersist(sdk: IMessageSDK, text: string): Promise<void> {
  await sendBubbles(sdk, text);
  // Store in messages table so it shows up in getRecentMessages() and future buffer seeds
  try {
    insertMessage({
      raw_text: `[alfred] ${text.replace(/\[SPLIT\]/g, " ")}`,
      media_type: "text",
    });
  } catch (err) {
    console.error("[proactive] failed to persist message:", err);
  }
  // Push to the live conversation buffer so an immediate reply has context
  if (globalBuffer) {
    globalBuffer.push({
      role: "assistant",
      content: text.replace(/\[SPLIT\]/g, " "),
      timestamp: new Date().toISOString(),
    });
  }
}

const PROACTIVE_SUFFIX = `

YOU ARE INITIATING THIS MESSAGE UNPROMPTED. Rules:
- Only send if you have something genuinely useful or timely to say
- If there's nothing worth saying, reply with exactly: SKIP
- One bubble max. No questions unless it's the whole point.
- Don't announce that you're checking in. Just say the thing.`;

function summarizeContext(
  contextData: Awaited<ReturnType<typeof fetchContext>>,
  includeTodoist: boolean,
): string {
  return [
    `identity=${contextData.memoryContext.identity.length}`,
    `bedrock=${contextData.memoryContext.bedrock.length}`,
    `retrieved=${contextData.memoryContext.retrieved.length}`,
    `todoist=${includeTodoist && contextData.todoistTasks ? "yes" : "no"}`,
  ].join(" ");
}

async function runProactiveChat(
  sdk: IMessageSDK,
  trigger: string,
  logType: string,
): Promise<void> {
  const emptyBuffer = new ConversationBuffer();
  const wantsTodoist = /\b(todoist|task|tasks|due|overdue)\b/i.test(trigger);
  const contextData = await fetchContext(emptyBuffer, { includeTodoist: wantsTodoist });
  const contextSummary = summarizeContext(contextData, wantsTodoist);
  const systemPrompt = buildPrompt(contextData, "full") + PROACTIVE_SUFFIX;

  let msg: string;
  try {
    msg = await chat(systemPrompt, `[internal: ${trigger}]`, { allowTools: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logProactiveAttempt({
      trigger_type: logType,
      trigger,
      decision: "error",
      reason,
      context_summary: contextSummary,
    });
    console.error(`[proactive] ${logType} → error:`, err);
    return;
  }

  if (!msg || msg.trim() === "SKIP" || msg.toUpperCase().includes("SKIP")) {
    console.log(`[proactive] ${logType} → skipped`);
    logProactiveAttempt({
      trigger_type: logType,
      trigger,
      decision: "skipped",
      reason: "model_skip",
      candidate: msg,
      context_summary: contextSummary,
    });
    return;
  }

  const gate = evaluateProactiveGate(msg);
  if (!gate.allowed) {
    console.log(`[proactive] ${logType} → blocked (${gate.reason}): "${msg.slice(0, 80)}"`);
    logProactiveAttempt({
      trigger_type: logType,
      trigger,
      decision: "blocked",
      reason: gate.reason,
      candidate: msg,
      context_summary: contextSummary,
    });
    return;
  }

  try {
    console.log(`[proactive] ${logType}: "${msg.slice(0, 80)}"`);
    await sendAndPersist(sdk, msg);
    logProactive(logType, msg);
    logProactiveAttempt({
      trigger_type: logType,
      trigger,
      decision: "sent",
      reason: gate.reason,
      candidate: msg,
      context_summary: contextSummary,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logProactiveAttempt({
      trigger_type: logType,
      trigger,
      decision: "error",
      reason,
      candidate: msg,
      context_summary: contextSummary,
    });
    console.error(`[proactive] ${logType} send failed:`, err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Type 1 — L0 Nudge
// ─────────────────────────────────────────────────────────────────────────────

async function sendNudgeForFact(
  sdk: IMessageSDK,
  fact: { id: number; text: string; proactive_after: string },
): Promise<void> {
  const contextFacts = [
    ...getLevel2Facts().slice(0, 5).map((f) => f.text),
    ...getBedrockFacts().slice(0, 3).map((f) => f.text),
  ];
  const contextStr = contextFacts.map((f) => `- ${f}`).join("\n");

  let nudgeMsg: string;
  try {
    const response = await makeOpenAIClient().chat.completions.create({
      model: config().LLM_MODEL,
      messages: [
        {
          role: "system",
          content: `You are Alfred, a close friend AI in iMessage. Based on a specific intention or tension the user expressed earlier, send ONE short natural check-in + call to action(1 sentence, 15 words or fewer, lowercase, no period, no em dashes). Sound like a real friend who remembered, not a reminder app. EXAMPLES: "u said u wanted to see tristen more, so hit him up before this becomes another thing u meant to do", "yo did u ever get to watching jumanji??", "ik uve been putting off implementing testing for ur project, hop of tiktok homie and just do it rn". If it's not worth saying/there's no value added, return exactly: SKIP`,
        },
        {
          role: "user",
          content: `WHO THEY ARE:\n${contextStr}\n\nINTENTION/TENSION FROM EARLIER:\n${fact.text}`,
        },
      ],
      max_tokens: 80,
    });
    nudgeMsg = response.choices[0]?.message?.content?.trim() ?? "SKIP";
  } catch (err) {
    console.error(`[proactive] nudge LLM failed for fact_${fact.id}:`, err);
    markNudgeFired(fact.id);
    return;
  }

  // Always mark fired so we don't retry
  markNudgeFired(fact.id);

  if (!nudgeMsg || nudgeMsg.toUpperCase().includes("SKIP")) {
    console.log(`[proactive] nudge → skipped for fact_${fact.id}`);
    logProactiveAttempt({
      trigger_type: "l0_nudge",
      trigger: `fact_${fact.id}: ${fact.text.slice(0, 60)}`,
      decision: "skipped",
      reason: "model_skip",
      candidate: nudgeMsg,
    });
    return;
  }

  const gate = evaluateProactiveGate(nudgeMsg);
  if (!gate.allowed) {
    console.log(`[proactive] nudge → blocked (${gate.reason}): "${nudgeMsg.slice(0, 60)}"`);
    logProactiveAttempt({
      trigger_type: "l0_nudge",
      trigger: `fact_${fact.id}: ${fact.text.slice(0, 60)}`,
      decision: "blocked",
      reason: gate.reason,
      candidate: nudgeMsg,
    });
    return;
  }

  try {
    console.log(`[proactive] l0_nudge: "${nudgeMsg.slice(0, 80)}"`);
    await sendAndPersist(sdk, nudgeMsg);
    logProactive("l0_nudge", nudgeMsg, fact.id);
    logProactiveAttempt({
      trigger_type: "l0_nudge",
      trigger: `fact_${fact.id}: ${fact.text.slice(0, 60)}`,
      decision: "sent",
      reason: gate.reason,
      candidate: nudgeMsg,
    });
  } catch (err) {
    console.error(`[proactive] nudge send failed for fact_${fact.id}:`, err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Type 2 — L1 Pattern Observation
// ─────────────────────────────────────────────────────────────────────────────

async function generatePatternObservation(
  patternText: string,
  contextFacts: string[],
): Promise<string> {
  const contextStr = contextFacts.map((f) => `- ${f}`).join("\n");
  try {
    const response = await makeOpenAIClient().chat.completions.create({
      model: config().LLM_MODEL,
      messages: [
        {
          role: "system",
          content: `You are Alfred, a close friend AI in iMessage. You've noticed a recurring pattern in this person's life. Write ONE short natural message (1 sentence, 20 words or fewer, lowercase, no period, no em dashes) that mentions what you've noticed and potentially a call to action; not analytically, but like a friend who just realized something. EXAMPLES: "whenever ur week is hella packed w work u tend to sacrifice ur sleep, want help figuring out how to get those hrs back?", "i feel like ur hella underconfident in urself, what do u think is causing that?", "I think u should move to Austin bro u thrive in warm weather".`,
        },
        {
          role: "user",
          content: `WHO THEY ARE:\n${contextStr}\n\nPATTERN YOU NOTICED:\n${patternText}`,
        },
      ],
      max_tokens: 100,
    });
    return response.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    console.error("[proactive] pattern obs LLM failed:", err);
    return "";
  }
}

async function runPatternObservation(sdk: IMessageSDK): Promise<void> {
  const queued = getQueuedPatternFacts();

  try {
    if (queued.length === 0) {
      console.log("[proactive] pattern_observation → nothing queued");
      return;
    }

    console.log(`[proactive] pattern_observation → evaluating ${queued.length} queued pattern(s)`);

    const l2Facts = getLevel2Facts().slice(0, 5).map((f) => f.text);
    const contextFacts = [...l2Facts, ...queued.map((f) => `[pattern] ${f.text}`)];

    let best: { msg: string; score: number; factId: number; reason: string } | null = null;

    for (const fact of queued) {
      const candidate = await generatePatternObservation(fact.text, l2Facts);
      if (!candidate) {
        console.log(`[proactive] pattern_obs fact_${fact.id} → empty response`);
        continue;
      }

      const { score, reason } = await judgeProactiveMessage(candidate, contextFacts);
      console.log(`[proactive] pattern_obs judge fact_${fact.id}: score=${score} (${reason}) "${candidate.slice(0, 60)}"`);

      if (score > (best?.score ?? 0)) {
        best = { msg: candidate, score, factId: fact.id, reason };
      }
    }

    if (!best || best.score < JUDGE_THRESHOLD) {
      const scoreStr = best ? `score=${best.score}<${JUDGE_THRESHOLD}` : "no_candidates";
      console.log(`[proactive] pattern_observation → skipped (${scoreStr})`);
      logProactiveAttempt({
        trigger_type: "pattern_observation",
        trigger: `${queued.length} queued pattern(s)`,
        decision: "skipped",
        reason: scoreStr,
        candidate: best?.msg,
      });
      return;
    }

    const gate = evaluateProactiveGate(best.msg);
    if (!gate.allowed) {
      console.log(`[proactive] pattern_observation → blocked (${gate.reason})`);
      logProactiveAttempt({
        trigger_type: "pattern_observation",
        trigger: `fact_${best.factId}`,
        decision: "blocked",
        reason: gate.reason,
        candidate: best.msg,
      });
      return;
    }

    console.log(`[proactive] pattern_observation: "${best.msg.slice(0, 80)}"`);
    await sendAndPersist(sdk, best.msg);
    logProactive("pattern_observation", best.msg, best.factId);
    logProactiveAttempt({
      trigger_type: "pattern_observation",
      trigger: `fact_${best.factId}`,
      decision: "sent",
      reason: gate.reason,
      candidate: best.msg,
    });
  } catch (err) {
    console.error("[proactive] pattern_observation failed:", err);
  } finally {
    clearAllPatternObservationQueued();
    console.log("[proactive] pattern_observation → cleared all queued flags");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Type 3 — External Synthesis
// ─────────────────────────────────────────────────────────────────────────────

async function runExternalSynthesis(sdk: IMessageSDK): Promise<void> {
  if (!config().FIRECRAWL_API_KEY) {
    console.log("[proactive] external_synthesis → no FIRECRAWL_API_KEY, skipped");
    return;
  }

  const l2Facts = getLevel2Facts().slice(0, 5);
  const l1Facts = getBedrockFacts().slice(0, 5);

  if (l2Facts.length === 0) {
    console.log("[proactive] external_synthesis → no L2 facts, skipped");
    logProactiveAttempt({
      trigger_type: "external_synthesis",
      trigger: "daily",
      decision: "skipped",
      reason: "no_l2_facts",
    });
    return;
  }

  const contextFacts = [...l2Facts.map((f) => f.text), ...l1Facts.map((f) => f.text)];
  const contextStr = contextFacts.map((f) => `- ${f}`).join("\n");

  // Generate recency-biased search queries
  let queries: string[] = [];
  try {
    const queryResponse = await makeOpenAIClient().chat.completions.create({
      model: config().EXTRACTION_MODEL,
      messages: [
        {
          role: "system",
          content: `Generate 2 web search queries to find recent/current information that would genuinely interest this person. Bias heavily toward recency, use phrases like "latest news about", "recent developments in", "what happened with". Return raw JSON: {"queries": ["...", "..."]}`,
        },
        { role: "user", content: `WHO THEY ARE:\n${contextStr}` },
      ],
      max_tokens: 200,
      response_format: { type: "json_object" },
    });
    const raw = stripJsonFences(queryResponse.choices[0]?.message?.content ?? "{}");
    const parsed = JSON.parse(raw) as { queries?: unknown };
    if (Array.isArray(parsed.queries)) {
      queries = parsed.queries.filter((q): q is string => typeof q === "string").slice(0, 2);
    }
  } catch (err) {
    console.error("[proactive] external_synthesis query generation failed:", err);
    return;
  }

  if (queries.length === 0) {
    console.log("[proactive] external_synthesis → no queries generated");
    logProactiveAttempt({
      trigger_type: "external_synthesis",
      trigger: "daily",
      decision: "skipped",
      reason: "no_queries_generated",
    });
    return;
  }

  // Run searches and collect results
  let searchResults = "";
  for (const query of queries) {
    try {
      console.log(`[proactive] external_synthesis searching: "${query}"`);
      const result = await searchWeb(query);
      searchResults += `QUERY: ${query}\n${result}\n\n---\n\n`;
    } catch (err) {
      console.error(`[proactive] external_synthesis search failed for "${query}":`, err);
    }
  }

  if (!searchResults.trim()) {
    console.log("[proactive] external_synthesis → no search results");
    logProactiveAttempt({
      trigger_type: "external_synthesis",
      trigger: queries.join("; ").slice(0, 100),
      decision: "skipped",
      reason: "no_search_results",
    });
    return;
  }

  // Synthesize a message
  let candidate: string;
  try {
    const synthResponse = await makeOpenAIClient().chat.completions.create({
      model: config().LLM_MODEL,
      messages: [
        {
          role: "system",
          content: `You are Alfred, a close friend AI in iMessage. Based on these search results and who this person is, write ONE short message + potential call to action (1 sentence, 20 words or fewer, lowercase, no period, no em dashes) sharing something genuinely interesting or relevant both to the user and to the world. Include a URL if it adds real value. EXAMPLES: "new dwarkesh podcast w stripe founder j dropped, if ur bored u should def check it out <link>", "since u like space-related movies if u have time u should watch Project Hail Mary it just came out recently heard its hype", "u were talking abt automating UGC talent discovery for Drymint well i found this twitter thread <link>".`,
        },
        {
          role: "user",
          content: `WHO THEY ARE:\n${contextStr}\n\nSEARCH RESULTS:\n${searchResults.slice(0, 3000)}`,
        },
      ],
      max_tokens: 150,
    });
    candidate = synthResponse.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    console.error("[proactive] external_synthesis synthesis failed:", err);
    return;
  }

  if (!candidate) {
    console.log("[proactive] external_synthesis → empty response");
    logProactiveAttempt({
      trigger_type: "external_synthesis",
      trigger: queries.join("; ").slice(0, 100),
      decision: "skipped",
      reason: "empty_response",
    });
    return;
  }

  // Judge it
  const { score, reason } = await judgeProactiveMessage(candidate, contextFacts);
  console.log(`[proactive] external_synthesis judge: score=${score} (${reason}) "${candidate.slice(0, 60)}"`);

  if (score < JUDGE_THRESHOLD) {
    console.log(`[proactive] external_synthesis → score ${score} < ${JUDGE_THRESHOLD}, skipped`);
    logProactiveAttempt({
      trigger_type: "external_synthesis",
      trigger: queries.join("; ").slice(0, 100),
      decision: "skipped",
      reason: `judge_score=${score}<${JUDGE_THRESHOLD}:${reason}`,
      candidate,
    });
    return;
  }

  const gate = evaluateProactiveGate(candidate);
  if (!gate.allowed) {
    console.log(`[proactive] external_synthesis → blocked (${gate.reason})`);
    logProactiveAttempt({
      trigger_type: "external_synthesis",
      trigger: queries.join("; ").slice(0, 100),
      decision: "blocked",
      reason: gate.reason,
      candidate,
    });
    return;
  }

  console.log(`[proactive] external_synthesis: "${candidate.slice(0, 80)}"`);
  await sendAndPersist(sdk, candidate);
  logProactive("external_synthesis", candidate);
  logProactiveAttempt({
    trigger_type: "external_synthesis",
    trigger: queries.join("; ").slice(0, 100),
    decision: "sent",
    reason: gate.reason,
    candidate,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Type 4 — Absence Reflection
// ─────────────────────────────────────────────────────────────────────────────

async function runAbsenceReflection(sdk: IMessageSDK): Promise<void> {
  const stale = getStaleBedrock(14);

  if (stale.length === 0) {
    console.log("[proactive] absence_reflection → nothing stale");
    logProactiveAttempt({
      trigger_type: "absence_reflection",
      trigger: "daily",
      decision: "skipped",
      reason: "nothing_stale",
    });
    return;
  }

  const l2Facts = getLevel2Facts().slice(0, 5).map((f) => f.text);
  const contextFacts = [...l2Facts, ...stale.slice(0, 3).map((f) => f.text)];
  const contextStr = l2Facts.map((f) => `- ${f}`).join("\n");

  const ABSENCE_SYSTEM = `You are Alfred, a close friend AI in iMessage. Something important in this person's life hasn't come up in a while. Write ONE short, directive check-in + potential call to action (1 sentence, 20 words or fewer, lowercase, no period, no em dashes). Sound like a friend who noticed; direct, not passive. One question max. EXAMPLES: "Hey i know u care abt being healthy but u havent been to the gym in like 2 weeks bro whats going on, u need help finding the time?", "progress on the startup has been looking barren recently...", "u haven't called ur sister in like 2 weeks what happened i thought u miss her 😭".`;

  // Try up to 3 stale facts in priority order; pick first that passes the judge
  for (const target of stale.slice(0, 3)) {
    let candidate: string;
    try {
      const response = await makeOpenAIClient().chat.completions.create({
        model: config().LLM_MODEL,
        messages: [
          { role: "system", content: ABSENCE_SYSTEM },
          { role: "user", content: `WHO THEY ARE:\n${contextStr}\n\nTHING THAT HASN'T COME UP LATELY:\n${target.text}` },
        ],
        max_tokens: 100,
      });
      candidate = response.choices[0]?.message?.content?.trim() ?? "";
    } catch (err) {
      console.error("[proactive] absence_reflection LLM failed:", err);
      continue;
    }

    if (!candidate) {
      console.log(`[proactive] absence_reflection → empty response for fact_${target.id}`);
      continue;
    }

    const { score, reason } = await judgeProactiveMessage(candidate, contextFacts);
    console.log(`[proactive] absence_reflection judge fact_${target.id}: score=${score} (${reason}) "${candidate.slice(0, 60)}"`);

    if (score < JUDGE_THRESHOLD) {
      console.log(`[proactive] absence_reflection → score ${score} < ${JUDGE_THRESHOLD} for fact_${target.id}, trying next`);
      logProactiveAttempt({
        trigger_type: "absence_reflection",
        trigger: `fact_${target.id}: ${target.text.slice(0, 60)}`,
        decision: "skipped",
        reason: `judge_score=${score}<${JUDGE_THRESHOLD}:${reason}`,
        candidate,
      });
      continue;
    }

    const gate = evaluateProactiveGate(candidate);
    if (!gate.allowed) {
      console.log(`[proactive] absence_reflection → blocked (${gate.reason})`);
      logProactiveAttempt({
        trigger_type: "absence_reflection",
        trigger: `fact_${target.id}: ${target.text.slice(0, 60)}`,
        decision: "blocked",
        reason: gate.reason,
        candidate,
      });
      return;
    }

    console.log(`[proactive] absence_reflection: "${candidate.slice(0, 80)}"`);
    await sendAndPersist(sdk, candidate);
    logProactive("absence_reflection", candidate, target.id);
    logProactiveAttempt({
      trigger_type: "absence_reflection",
      trigger: `fact_${target.id}: ${target.text.slice(0, 60)}`,
      decision: "sent",
      reason: gate.reason,
      candidate,
    });
    return;
  }

  console.log("[proactive] absence_reflection → no candidate passed judge across all stale facts");
  logProactiveAttempt({
    trigger_type: "absence_reflection",
    trigger: `exhausted ${stale.slice(0, 3).length} stale fact(s)`,
    decision: "skipped",
    reason: "no_candidate_passed_judge",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reminders (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

export function checkDueReminders(sdk: IMessageSDK): void {
  const due = getDueReminders();
  for (const reminder of due) {
    sendReminderIfAllowed(sdk, reminder, "message_triggered_reminder").catch(console.error);
  }
}

/**
 * Send a reminder. bypassGate=true skips quiet-hours and min-gap checks —
 * used by the per-minute cron for strictly-due reminders the user explicitly set.
 * Message-triggered reminders (opportunistic 1h window) keep the gate.
 */
async function sendReminderIfAllowed(
  sdk: IMessageSDK,
  reminder: { id: number; text: string; due_at: string },
  triggerType: string,
  opts: { bypassGate?: boolean } = {},
): Promise<void> {
  const text = `hey don't forget — ${reminder.text}`;
  const trigger = `reminder due_at=${reminder.due_at} id=${reminder.id}`;

  if (!opts.bypassGate) {
    const gate = evaluateProactiveGate(text);
    if (!gate.allowed) {
      console.log(`[proactive] reminder → blocked (${gate.reason}): "${reminder.text.slice(0, 80)}"`);
      logProactiveAttempt({
        trigger_type: triggerType,
        trigger,
        decision: "blocked",
        reason: gate.reason,
        candidate: text,
      });
      return;
    }
  }

  // Atomically claim fired_at before awaiting sendBubbles so a slow tick (>60s due to
  // LLM calls in checkMissedCrons) can't race with the next per-minute tick and send twice.
  const claimed = db()
    .prepare("UPDATE reminders SET fired_at = datetime('now') WHERE id = ? AND fired_at IS NULL")
    .run(reminder.id).changes === 1;

  if (!claimed) return; // concurrent tick already sent this one

  try {
    await sendAndPersist(sdk, text);
    logProactive("reminder", text);
    logProactiveAttempt({
      trigger_type: triggerType,
      trigger,
      decision: "sent",
      reason: opts.bypassGate ? "reminder_bypass" : "allowed",
      candidate: text,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logProactiveAttempt({
      trigger_type: triggerType,
      trigger,
      decision: "error",
      reason,
      candidate: text,
    });
    console.error(`[proactive] reminder send failed:`, err);
  }
}

/**
 * Batch multiple simultaneous reminders into a single message.
 * Atomically claims all reminders before sending so concurrent ticks can't double-fire.
 */
async function sendBatchReminders(
  sdk: IMessageSDK,
  reminders: Array<{ id: number; text: string; due_at: string }>,
): Promise<void> {
  // Atomically claim all reminders first
  const claimed: typeof reminders = [];
  for (const reminder of reminders) {
    const ok = db()
      .prepare("UPDATE reminders SET fired_at = datetime('now') WHERE id = ? AND fired_at IS NULL")
      .run(reminder.id).changes === 1;
    if (ok) claimed.push(reminder);
  }

  if (claimed.length === 0) return;

  const batchText = claimed.length === 1
    ? `hey don't forget — ${claimed[0].text}`
    : `hey heads up, you got a few things:\n${claimed.map((r) => `• ${r.text}`).join("\n")}`;

  const trigger = `batch_reminder: ${claimed.map((r) => r.id).join(",")}`;

  try {
    await sendAndPersist(sdk, batchText);
    logProactive("reminder", batchText);
    logProactiveAttempt({
      trigger_type: "reminder",
      trigger,
      decision: "sent",
      reason: `batch_${claimed.length}`,
      candidate: batchText,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logProactiveAttempt({
      trigger_type: "reminder",
      trigger,
      decision: "error",
      reason,
      candidate: batchText,
    });
    console.error("[proactive] batch reminder send failed:", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Named daily jobs (extracted so catch-up can call them directly)
// ─────────────────────────────────────────────────────────────────────────────

const CATCHUP_EXCUSE = `\n\nNOTE: you're sending this late because alfred was offline (mac was asleep). open with a SHORT funny surreal excuse for the delay woven naturally into the message, something absurd and self-aware like "sorry i was walking my fish but...", "oops ngl i fell asleep but...", "was busy teaching my goldfish to code but...". keep the whole message under 35 words.`;

async function runMorningBrief(sdk: IMessageSDK, catchUp = false): Promise<void> {
  const upcoming = getUpcomingEventFacts(7);
  const upcomingStr = upcoming.length > 0
    ? upcoming.map((f) => `${f.text}${f.event_date ? ` (${f.event_date})` : ""}`).join("; ")
    : "none";

  const trigger = `morning brief. check their todoist tasks for today using todoist_list_tasks. upcoming events from memory: ${upcomingStr}. if there's something worth flagging, such as an overdue task, something happening soon, anything they should know today, say it. EXAMPLES: "wakey wakey, u have hella to do today. cmsc411 hw due tn and astronomy test tmr so lock in!!", "i would say rise and grind but doesn't seem like u have anything due rly soon". Otherwise SKIP.${catchUp ? CATCHUP_EXCUSE : ""}`;

  await runProactiveChat(sdk, trigger, "morning_brief");
}

async function runEveningWrap(sdk: IMessageSDK, catchUp = false): Promise<void> {
  const trigger = `evening check-in. use todoist_list_tasks with filter "today | overdue" to see what's still open. if there are overdue or incomplete tasks worth flagging, do it. EXAMPLES: "hey, u still haven't gotten to cmsc411 hw?", "lucky for u ur work seems done for today meaning u can go touch some grass", "lock in bro why are u putting off talking to jack u said u would do it ages ago and it still isn't done". If nothing meaningful is open, SKIP.${catchUp ? CATCHUP_EXCUSE : ""}`;

  await runProactiveChat(sdk, trigger, "evening_wrap");
}

// ─────────────────────────────────────────────────────────────────────────────
// Catch-up logic — recovers jobs missed while Mac was asleep
// ─────────────────────────────────────────────────────────────────────────────

function getCurrentHourInTz(tz: string): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(new Date()),
    10,
  );
}

// In-process guard: prevents concurrent per-minute ticks from double-firing the same job.
// Node.js is single-threaded, so Set.has() + Set.add() between awaits is safe without locks.
const runningJobs = new Set<string>();

/** Stamp cron_state then run fn, skipping if already in flight. */
async function tracked(jobName: string, fn: () => Promise<void>): Promise<void> {
  if (runningJobs.has(jobName)) return;
  runningJobs.add(jobName);
  setCronLastRan(jobName);
  try {
    await fn();
  } finally {
    runningJobs.delete(jobName);
  }
}

async function checkMissedCrons(sdk: IMessageSDK): Promise<void> {
  const tz = config().USER_TIMEZONE;
  const currentHour = getCurrentHourInTz(tz);
  const now = Date.now();
  const hourMs = 3_600_000;

  // Daily jobs: catch up if missed within a 4-hour window after scheduled time
  const dailyJobs: Array<{ name: string; hour: number; run: () => Promise<void> }> = [
    { name: "morning_brief",       hour: 9,  run: () => runMorningBrief(sdk, true) },
    { name: "external_synthesis",  hour: 13, run: () => runExternalSynthesis(sdk) },
    { name: "absence_reflection",  hour: 17, run: () => runAbsenceReflection(sdk) },
    { name: "evening_wrap",        hour: 19, run: () => runEveningWrap(sdk, true) },
  ];

  for (const job of dailyJobs) {
    if (currentHour < job.hour || currentHour >= job.hour + 4) continue;
    const lastRan = getCronLastRan(job.name);
    const hoursSince = lastRan ? (now - lastRan.getTime()) / hourMs : Infinity;
    if (hoursSince < 23) continue;
    const ago = lastRan ? `${Math.round(hoursSince)}h ago` : "never";
    console.log(`[proactive] catch-up: ${job.name} missed (last ran ${ago}), running now`);
    await tracked(job.name, job.run).catch(console.error);
  }

  // 6-hourly jobs: catch up if overdue by more than 6 hours
  const sixHourlyJobs: Array<{ name: string; run: () => Promise<void> }> = [
    { name: "consolidate_l0",      run: () => consolidateExpiredLevel0() },
    { name: "pattern_observation", run: () => runPatternObservation(sdk) },
  ];

  for (const job of sixHourlyJobs) {
    const lastRan = getCronLastRan(job.name);
    const hoursSince = lastRan ? (now - lastRan.getTime()) / hourMs : Infinity;
    if (hoursSince < 6) continue;
    const ago = lastRan ? `${Math.round(hoursSince)}h ago` : "never";
    console.log(`[proactive] catch-up: ${job.name} missed (last ran ${ago}), running now`);
    await tracked(job.name, job.run).catch(console.error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerCronJobs(sdk: IMessageSDK, buffer?: ConversationBuffer): void {
  if (buffer) globalBuffer = buffer;
  const tz = config().USER_TIMEZONE;

  // Every minute — fire due reminders, due L0 nudges, and catch-up any missed scheduled jobs
  cron.schedule("* * * * *", async () => {
    const dueReminders = getStrictlyDueReminders();
    if (dueReminders.length > 1) {
      // Batch multiple simultaneous reminders into a single message to avoid spam
      await sendBatchReminders(sdk, dueReminders).catch(console.error);
    } else if (dueReminders.length === 1) {
      await sendReminderIfAllowed(sdk, dueReminders[0], "reminder", { bypassGate: true }).catch(console.error);
    }

    const dueNudges = getNudgeDueFacts();
    for (const fact of dueNudges) {
      await sendNudgeForFact(sdk, fact).catch(console.error);
    }

    await checkMissedCrons(sdk).catch(console.error);
  }, { timezone: tz });

  // Every 6 hours — expire L0 facts, then run L1 pattern observation
  cron.schedule("17 */6 * * *", async () => {
    await tracked("consolidate_l0", () => consolidateExpiredLevel0()).catch(console.error);
  }, { timezone: tz });

  cron.schedule("20 */6 * * *", async () => {
    await tracked("pattern_observation", () => runPatternObservation(sdk)).catch(console.error);
  }, { timezone: tz });

  // Weekly — promote supported behavioral patterns into identity/value memories
  cron.schedule("30 3 * * 0", async () => {
    await promoteLevel1Patterns().catch(console.error);
  }, { timezone: tz });

  // 9am — morning brief
  cron.schedule("0 9 * * *", async () => {
    await tracked("morning_brief", () => runMorningBrief(sdk)).catch(console.error);
  }, { timezone: tz });

  // 1pm — Type 3: external synthesis (4h after morning brief for gate clearance)
  cron.schedule("0 13 * * *", async () => {
    await tracked("external_synthesis", () => runExternalSynthesis(sdk)).catch(console.error);
  }, { timezone: tz });

  // 5pm — Type 4: absence reflection (4h after external synthesis, 2h before evening wrap)
  cron.schedule("0 17 * * *", async () => {
    await tracked("absence_reflection", () => runAbsenceReflection(sdk)).catch(console.error);
  }, { timezone: tz });

  // 7pm — evening wrap
  cron.schedule("0 19 * * *", async () => {
    await tracked("evening_wrap", () => runEveningWrap(sdk)).catch(console.error);
  }, { timezone: tz });
}
