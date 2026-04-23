import { z } from "zod";
import { config } from "../config.js";
import { llmClient } from "./llm.js";

export type ResponseMode = "silent" | "acknowledge" | "brief" | "full";

const schema = z.object({
  mode: z.enum(["silent", "acknowledge", "brief", "full"]),
});

/** Extract the JSON object from a string, ignoring fences and trailing explanation text. */
function extractJSON(s: string): string {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return s.slice(start, end + 1);
  return s.trim();
}

const PROMPT = `Decide how Alfred should respond to this iMessage. Return ONLY raw JSON: { "mode": "silent" | "acknowledge" | "brief" | "full" }

bias toward silent and acknowledge. Most messages don't need a full response.

silent — pure reactions, nothing to confirm, no action taken ("lol", "fr", "damn", "ok", "yeah", "nice", "bet", "deadass")
  → "lol fr" / "ya true" / "deadass" / "woke up at 7" (pure info dump, no action needed)

acknowledge — user wants to feel heard or confirmed, but doesn't want conversation. Action was implicit (reminder set, note taken) or they're sharing something heavy without asking for engagement.
  → "remind me to call mom tomorrow" / "note that i have a meeting at 3" / "i'm so tired of this" / "just finished a 10 mile run" / "my summer is split into 3 tracks" / "i don't wanna talk about it"

brief — worth a quick take or reaction, not just confirmation. One sentence opinion or observation.
  → "kinda nervous about tomorrow" / "just finished the project" / "might apply to that fellowship" / "thinking about X"

full — explicit question, request for help, or asking for Alfred's opinion on something specific.
  → "what do you think about X?" / "help me plan Y" / "should I do A or B?" / "can you look up Z?"

Default to acknowledge if unsure. Only pick full if they clearly want a response.`;

export interface ClassifierMessage {
  role: "user" | "assistant";
  content: string;
}

export async function classifyWithTimeout(
  userMessage: string,
  recentMessages: ClassifierMessage[] = [],
  timeoutMs = 5000,
): Promise<ResponseMode> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<ResponseMode>((resolve) => {
    timer = setTimeout(() => {
      console.log(`[classifier] timeout after ${timeoutMs}ms → brief`);
      resolve("brief");
    }, timeoutMs);
  });
  return Promise.race([
    classifyIntent(userMessage, recentMessages).finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

export async function classifyIntent(
  userMessage: string,
  recentMessages: ClassifierMessage[] = [],
): Promise<ResponseMode> {
  const t0 = Date.now();

  // Build context string from recent conversation so classifier understands follow-ups
  const contextBlock = recentMessages.length > 0
    ? `\nRECENT CONVERSATION (for context only):\n${recentMessages.map((m) => `${m.role === "assistant" ? "alfred" : "them"}: ${m.content}`).join("\n")}\n`
    : "";

  try {
    const response = await llmClient().chat.completions.create({
      model: "google/gemini-2.5-flash-lite",
      messages: [
        { role: "system", content: PROMPT + contextBlock },
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
