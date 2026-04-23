import { IMessageSDK } from "@photon-ai/imessage-kit";
import { config } from "../config.js";

/**
 * Enforce Alfred's formatting rules post-generation, since smaller models
 * (haiku) often ignore them: no trailing periods, max 2 bubbles.
 */
function cleanBubble(text: string): string {
  // Strip trailing period (but not "..." ellipsis or URLs)
  return text.replace(/(?<!\.)\.(\s*)$/, "$1").trim();
}

export async function sendBubbles(sdk: IMessageSDK, text: string): Promise<void> {
  const bubbles = text
    .split("[SPLIT]")
    .map((s) => cleanBubble(s.trim()))
    .filter(Boolean)
    .slice(0, 2); // hard cap at 2 bubbles

  for (let i = 0; i < bubbles.length; i++) {
    const t = Date.now();
    await sdk.send({ to: config().USER_PHONE, text: bubbles[i] });
    console.log(`[response] bubble ${i + 1}/${bubbles.length} sent (${Date.now() - t}ms): "${bubbles[i].slice(0, 60)}"`);
    if (i < bubbles.length - 1) {
      console.log(`[response] sleeping 1500ms between bubbles`);
      await sleep(1500);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
