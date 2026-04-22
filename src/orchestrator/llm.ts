import OpenAI from "openai";
import { config } from "../config.js";
import { getTools, executeTool } from "../tools/registry.js";

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

/**
 * Alfred's main response loop. Supports tool calling — Alfred can search the
 * web, read URLs, and manage Todoist tasks mid-response before sending its
 * final reply.
 */
export async function chat(
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const tools = getTools();

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const MAX_ITERATIONS = 8; // enough for list + N mutations or multi-step web research

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await llmClient().chat.completions.create({
      model: config().LLM_MODEL,
      messages,
      max_tokens: 200,
      temperature: 0.9,
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    });

    const msg = response.choices[0].message;
    messages.push(msg);

    // No tool calls — this is the final text response
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content?.trim() ?? "...";
    }

    // Execute all tool calls in this turn (may be parallel)
    await Promise.all(
      msg.tool_calls
        .filter((call) => call.type === "function")
        .map(async (call) => {
          const args = JSON.parse(call.function.arguments) as Record<string, string>;
          const result = await executeTool(call.function.name, args);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: result,
          });
        }),
    );
  }

  // Shouldn't reach here — return whatever the last text content was
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
      return m.content.trim();
    }
  }
  return "...";
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
