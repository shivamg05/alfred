import { z } from "zod";
import { config } from "../config.js";
import { llmClient } from "./llm.js";

export type ResponseMode = "silent" | "brief" | "full";

const schema = z.object({
  mode: z.enum(["silent", "brief", "full"]),
});

/** Extract the JSON object from a string, ignoring fences and trailing explanation text. */
function extractJSON(s: string): string {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return s.slice(start, end + 1);
  return s.trim();
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

export async function classifyWithTimeout(
  userMessage: string,
  timeoutMs = 5000,
): Promise<ResponseMode> {
  return Promise.race([
    classifyIntent(userMessage),
    new Promise<ResponseMode>((resolve) =>
      setTimeout(() => {
        console.log(`[classifier] timeout after ${timeoutMs}ms → brief`);
        resolve("brief");
      }, timeoutMs),
    ),
  ]);
}

export async function classifyIntent(
  userMessage: string,
): Promise<ResponseMode> {
  const t0 = Date.now();
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
    const parsed = schema.safeParse(JSON.parse(extractJSON(raw)));
    const mode = parsed.success ? parsed.data.mode : "brief";
    console.log(`[classifier] ${mode} (${Date.now() - t0}ms)`);
    return mode;
  } catch {
    console.log(`[classifier] failed → brief (${Date.now() - t0}ms)`);
    return "brief";
  }
}
