import { z } from "zod";
import { config } from "../config.js";
import { llmClient } from "./llm.js";

export type ResponseMode = "silent" | "brief" | "full";

const schema = z.object({
  mode: z.enum(["silent", "brief", "full"]),
});

/** Strip markdown code fences in case the model wraps its JSON output */
function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

const PROMPT = `Decide how Alfred should respond to this iMessage. Return ONLY raw JSON: { "mode": "silent" | "brief" | "full" }

BIAS HARD toward silent and brief. Most messages don't need a full response.

silent — logging, venting, info dump, no question asked, short reactions ("lol", "fr", "damn", "ok", "yeah", "nice")
  → "my summer is split into 3 tracks" / "woke up at 7" / "lol fr" / "ya true" / "deadass" / "bet"

brief — worth a quick take but not a full conversation. One sentence.
  → "kinda nervous about tomorrow" / "just finished the project" / "might apply to that fellowship" / "thinking about X"

full — explicit question, request for help, or asking for Alfred's opinion on something specific.
  → "what do you think about X?" / "help me plan Y" / "should I do A or B?" / "can you look up Z?"

Default to brief if unsure. Only pick full if they clearly want a response.`;

export async function classifyIntent(
  userMessage: string,
): Promise<ResponseMode> {
  try {
    const response = await llmClient().chat.completions.create({
      model: config().EXTRACTION_MODEL,
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: userMessage },
      ],
      max_tokens: 60,
      temperature: 0,
    });

    const raw = response.choices[0]?.message?.content ?? '{"mode":"brief"}';
    const parsed = schema.safeParse(JSON.parse(stripFences(raw)));
    return parsed.success ? parsed.data.mode : "brief";
  } catch {
    return "brief"; // fail to brief, not full
  }
}
