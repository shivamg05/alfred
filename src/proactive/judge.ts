import { config } from "../config.js";
import { makeOpenAIClient } from "../orchestrator/llm.js";

const JUDGE_PROMPT = `You evaluate whether a proactive message from a personal AI is worth sending.

Score the candidate message 0-100 on three axes:
- Relevance (0-40): Is this about something that genuinely matters to this person based on who they are?
- Timing (0-30): Does this feel timely — not stale, not premature, not forced?
- Tone (0-30): Does this sound like something a close friend would say naturally, not a bot?

Score honestly. Return raw JSON only: {"score": <0-100>, "reason": "<one short phrase>"}`;

export async function judgeProactiveMessage(
  candidate: string,
  contextFacts: string[],
): Promise<{ score: number; reason: string }> {
  const context = contextFacts.length > 0
    ? contextFacts.map((f) => `- ${f}`).join("\n")
    : "(no context)";

  let raw: string;
  try {
    const response = await makeOpenAIClient().chat.completions.create({
      model: config().EXTRACTION_MODEL,
      messages: [
        { role: "system", content: JUDGE_PROMPT },
        { role: "user", content: `WHO THEY ARE:\n${context}\n\nCANDIDATE MESSAGE:\n${candidate}` },
      ],
      max_tokens: 60,
      response_format: { type: "json_object" },
    });
    raw = (response.choices[0]?.message?.content ?? '{"score":0,"reason":"no_response"}')
      .replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  } catch (err) {
    console.error("[judge] LLM call failed:", err);
    return { score: 0, reason: "llm_error" };
  }

  try {
    const parsed = JSON.parse(raw) as { score?: number; reason?: string };
    return {
      score: typeof parsed.score === "number" ? Math.max(0, Math.min(100, parsed.score)) : 0,
      reason: typeof parsed.reason === "string" ? parsed.reason : "parse_error",
    };
  } catch {
    return { score: 0, reason: "parse_error" };
  }
}

export const JUDGE_THRESHOLD = 70;
