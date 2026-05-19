import { z } from "zod";
import { config } from "../config.js";
import { llmClient } from "./llm.js";
import { logPrompt } from "../debug/promptLog.js";

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

silent: pure reaction, throwaway text, or nothing to confirm or engage with, or if the message feels as if it will be followed by another (is an incomplete thought); applies when it would be appropriate for someone to politely smile in response.
  → "lol", "fr", "ok", "ya thats true", "deadass", "bet", "💀", "that was crazy"

acknowledge: explicit command to record/note/do something, or the user clearly only wants receipt confirmation; applies when it would be appropriate for someone to nod in response.
  → "remind me to call mom tomorrow" / "note that i have a meeting at 3" / "i don't wanna talk about it" / "just fyi i'm heading out" / "just got back from the gym"
  NOT acknowledge: venting, sharing news, updates about their life, anything that opens a topic

brief: sharing something, venting, starting a topic, emotionally addressing Alfred, or updating Alfred on their life. Invites a natural reaction or follow-up, but does not need tools.
  → "work has been crazy" / "kinda nervous about tomorrow" / "just finished the project" / "my summer is split into 3 tracks" / "i'm so tired of this" / "i should probably go to the gym..."

full: explicit question, request, or asking Alfred to do/look up/check something.
  → "what do you think about X?" / "help me plan Y" / "should I do A or B?" / "can you look up Z?" / "where am I?" / "tell me X" / "find me X"

When the conversation context shows a prior question or request, treat follow-ups as full.
Default to brief if unsure.`;

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

const ACK_PROMPT = `You are Alfred, a personal AI in iMessage. Generate a single short acknowledgment (1-4 words max) for the message below. It should feel natural and human — like a friend texting back. Match the tone. No punctuation at end. Lowercase only. Examples: "noted", "got it", "👍", "on it", "makes sense", "yep got it", "noted 👍".`;

export async function generateContextualAck(
  userMessage: string,
  recentMessages: ClassifierMessage[] = [],
): Promise<string> {
  const fallbacks = ["noted", "got it", "👍", "noted 👍", "yep noted"];
  const t0 = Date.now();
  try {
    const contextBlock = recentMessages.length > 0
      ? `\nRECENT CONVERSATION:\n${recentMessages.slice(-4).map((m) => `[${m.role === "assistant" ? "alfred" : "user"}]: ${m.content}`).join("\n")}\n`
      : "";
    logPrompt("ack", ACK_PROMPT + contextBlock, { userMessage });

    const response = await llmClient().chat.completions.create({
      model: "google/gemini-2.5-flash-lite",
      messages: [
        { role: "system", content: ACK_PROMPT + contextBlock },
        { role: "user", content: userMessage },
      ],
      max_tokens: 20,
      temperature: 0.7,
    });
    const raw = (response.choices[0]?.message?.content ?? "").trim();
    console.log(`[classifier] ack generated: "${raw}" (${Date.now() - t0}ms)`);
    return raw || fallbacks[Math.floor(Math.random() * fallbacks.length)];
  } catch {
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
}

export async function classifyIntent(
  userMessage: string,
  recentMessages: ClassifierMessage[] = [],
): Promise<ResponseMode> {
  const t0 = Date.now();

  // Only feed last 3 messages — enough for follow-up detection without
  // bloating the cheap/fast classifier with irrelevant history.
  const tail = recentMessages.slice(-3);
  const contextBlock = tail.length > 0
    ? `\nRECENT CONVERSATION (for context only):\n${tail.map((m) => `[${m.role === "assistant" ? "alfred" : "user"}]: ${m.content}`).join("\n")}\n`
    : "";

  try {
    const classifierSystem = PROMPT + contextBlock;
    logPrompt("classifier", classifierSystem, {
      userMessage,
      meta: { model: "google/gemini-2.5-flash-lite", tailSize: String(tail.length) },
    });

    const response = await llmClient().chat.completions.create({
      model: "google/gemini-2.5-flash-lite",
      messages: [
        { role: "system", content: classifierSystem },
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
