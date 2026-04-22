import { z } from "zod";
import { config } from "../config.js";
import { llmClient } from "./llm.js";

export type ResponseMode = "silent" | "brief" | "full";

const schema = z.object({
  mode: z.enum(["silent", "brief", "full"]),
});

const PROMPT = `Decide how Alfred should respond to this iMessage.

Return JSON: { "mode": "silent" | "brief" | "full" }

silent — user is logging something for memory. No reply expected, potentially an acknowledgment (such as a 👍 or 'gotcha' or 'cool' etc). Pure info dumps, plans stated flatly, facts about their day.
  e.g. "my summer is split into 3 tracks", "meeting got moved to thursday", "woke up at 7", etc

brief — worth a reaction or quick take, but not a full conversation. One sentence max.
  e.g. "wanna read that paper later", "just finished the project", "kind of nervous about tomorrow", "might apply to that fellowship", etc

full — user wants actual back-and-forth, help, or asked a real question.
  e.g. "what do you think about X", "help me plan Y", "should I do A or B", "can you look up Z", etc

When torn between silent and brief, go brief.
When torn between brief and full, go brief.`;

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
      max_tokens: 20,
      temperature: 0,
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? '{"mode":"full"}';
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.mode : "full";
  } catch {
    return "full"; // fail open — always respond rather than go silent on error
  }
}
