import { ConversationBuffer } from "../memory/shortTerm.js";
import { retrieveContext } from "../memory/retrieval.js";
import { buildSystemPrompt } from "../tone/systemPrompt.js";

export async function buildContext(
  buffer: ConversationBuffer,
): Promise<string> {
  const recentMessages = buffer.getRecent(20);

  const latestUserMsg = recentMessages.filter((m) => m.role === "user").at(-1)?.content ?? "";
  const memoryContext = await retrieveContext(latestUserMsg);

  return buildSystemPrompt(memoryContext, recentMessages);
}
