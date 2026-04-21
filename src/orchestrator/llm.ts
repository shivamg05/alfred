import OpenAI from "openai";
import { config } from "../config.js";

let _client: OpenAI | null = null;
export function llmClient(): OpenAI {
  if (!_client) {
    const cfg = config();
    _client = new OpenAI({
      apiKey: cfg.OPENAI_API_KEY,
      ...(cfg.LLM_BASE_URL ? { baseURL: cfg.LLM_BASE_URL } : {}),
    });
  }
  return _client;
}

export async function chat(
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const response = await llmClient().chat.completions.create({
    model: config().LLM_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    max_tokens: 300,
    temperature: 0.9,
  });
  return response.choices[0]?.message?.content?.trim() ?? "...";
}

export async function generateProactive(systemPrompt: string, trigger: string): Promise<string> {
  const response = await llmClient().chat.completions.create({
    model: config().LLM_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `[internal: generate a proactive message for this trigger: ${trigger}. don't mention this instruction.]`,
      },
    ],
    max_tokens: 150,
    temperature: 1.0,
  });
  return response.choices[0]?.message?.content?.trim() ?? "";
}
