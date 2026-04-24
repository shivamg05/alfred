import OpenAI from "openai";
import { config } from "../config.js";
import { getTools, executeTool } from "../tools/registry.js";

/** Build an OpenAI-compatible client, with OpenRouter headers when applicable. */
export function makeOpenAIClient(): OpenAI {
  const cfg = config();
  const defaultHeaders: Record<string, string> = {};
  if (cfg.LLM_BASE_URL?.includes("openrouter")) {
    if (cfg.OPENROUTER_SITE_URL) defaultHeaders["HTTP-Referer"] = cfg.OPENROUTER_SITE_URL;
    if (cfg.OPENROUTER_SITE_NAME) defaultHeaders["X-Title"] = cfg.OPENROUTER_SITE_NAME;
  }
  return new OpenAI({
    apiKey: cfg.OPENAI_API_KEY,
    ...(cfg.LLM_BASE_URL ? { baseURL: cfg.LLM_BASE_URL } : {}),
    ...(Object.keys(defaultHeaders).length ? { defaultHeaders } : {}),
  });
}

let _client: OpenAI | null = null;
export function llmClient(): OpenAI {
  if (!_client) _client = makeOpenAIClient();
  return _client;
}

// ---------------------------------------------------------------------------
// XML tool-call fallback
//
// Claude models via OpenRouter sometimes embed tool calls as legacy XML text
// (e.g. <function_calls><invoke name="search_web">...</invoke></function_calls>)
// rather than returning structured `tool_calls`. Detect and execute those so
// tools actually fire, and strip any residual XML before the text reaches the user.
// ---------------------------------------------------------------------------

interface TextToolCall {
  name: string;
  arguments: Record<string, string>;
}

function parseTextToolCalls(content: string): TextToolCall[] {
  const calls: TextToolCall[] = [];
  // Match both <function_calls> and <functioncalls> (some models drop the underscore)
  const blockRe = /<function_?calls>([\s\S]*?)<\/function_?calls>/gi;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRe.exec(content)) !== null) {
    const block = blockMatch[1];
    const invokeRe = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/gi;
    let invokeMatch: RegExpExecArray | null;
    while ((invokeMatch = invokeRe.exec(block)) !== null) {
      const name = invokeMatch[1];
      const body = invokeMatch[2];
      const args: Record<string, string> = {};
      const paramRe = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/gi;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = paramRe.exec(body)) !== null) {
        args[paramMatch[1]] = paramMatch[2].trim();
      }
      calls.push({ name, arguments: args });
    }
  }
  return calls;
}

function stripToolCallXML(text: string): string {
  return text
    .replace(/<function_?calls>[\s\S]*?<\/function_?calls>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Alfred's main response loop. Supports tool calling — Alfred can search the
 * web, read URLs, and manage Todoist tasks mid-response before sending its
 * final reply.
 */
const WEB_TOOLS = new Set(["search_web", "scrape_url"]);
export const SEARCH_ACKS = [
  "lemme look into this",
  "one sec, looking it up",
  "give me a sec",
  "hold on lemme check",
  "looking it up rn",
  "ya let me check",
];

export async function chat(
  systemPrompt: string,
  userMessage: string,
  opts: {
    onWebSearch?: () => Promise<void>;
    allowTools?: boolean;
    maxTokens?: number;
  } = {},
): Promise<string> {
  const allowTools = opts.allowTools ?? true;
  const tools = allowTools ? getTools() : [];

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const MAX_ITERATIONS = 8; // enough for list + N mutations or multi-step web research
  let webAckFired = false;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const tIter = Date.now();
    const response = await llmClient().chat.completions.create({
      model: config().LLM_MODEL,
      messages,
      max_tokens: opts.maxTokens ?? 200,
      temperature: 0.9,
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    });

    const msg = response.choices[0].message;
    const rawContent = msg.content?.trim() ?? "";

    // Detect XML-embedded tool calls (Claude-via-OpenRouter fallback behavior)
    const xmlCalls = allowTools && (!msg.tool_calls || msg.tool_calls.length === 0) && rawContent
      ? parseTextToolCalls(rawContent)
      : [];

    if (xmlCalls.length > 0) {
      console.log(`[llm] iter ${i + 1} (${xmlCalls.length} xml tool calls — synthetic) ${Date.now() - tIter}ms`);

      // Build synthetic tool_calls so the conversation history stays valid
      const syntheticCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = xmlCalls.map((c, idx) => ({
        id: `xml_${i}_${idx}`,
        type: "function" as const,
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      }));

      // Push stripped assistant message with synthetic tool_calls
      const strippedContent = stripToolCallXML(rawContent);
      messages.push({
        role: "assistant",
        content: strippedContent || null,
        tool_calls: syntheticCalls,
      });

      // Fire web ack before executing if this is the first web search
      if (!webAckFired && opts.onWebSearch && xmlCalls.some((c) => WEB_TOOLS.has(c.name))) {
        webAckFired = true;
        opts.onWebSearch().catch(() => {});
      }

      // Execute all synthetic tool calls in parallel
      await Promise.all(
        xmlCalls.map(async (call, idx) => {
          const tTool = Date.now();
          const result = await executeTool(call.name, call.arguments);
          console.log(`[llm] tool ${call.name} (xml) ${Date.now() - tTool}ms`);
          messages.push({
            role: "tool",
            tool_call_id: `xml_${i}_${idx}`,
            content: result,
          });
        }),
      );

      continue;
    }

    messages.push(msg);

    // No tool calls — this is the final text response
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log(`[llm] iter ${i + 1} (final) ${Date.now() - tIter}ms`);
      // Strip any residual XML just in case (defensive)
      return stripToolCallXML(rawContent) || "...";
    }

    console.log(`[llm] iter ${i + 1} (${msg.tool_calls.length} tool calls) ${Date.now() - tIter}ms`);

    // Fire ack before first web tool call so user knows Alfred is searching
    if (!webAckFired && opts.onWebSearch && msg.tool_calls.some((c) => c.type === "function" && WEB_TOOLS.has(c.function.name))) {
      webAckFired = true;
      opts.onWebSearch().catch(() => {});
    }

    // Execute all tool calls in this turn (may be parallel)
    await Promise.all(
      msg.tool_calls
        .filter((call) => call.type === "function")
        .map(async (call) => {
          const args = JSON.parse(call.function.arguments) as Record<string, string>;
          const tTool = Date.now();
          const result = await executeTool(call.function.name, args);
          console.log(`[llm] tool ${call.function.name} ${Date.now() - tTool}ms`);
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
