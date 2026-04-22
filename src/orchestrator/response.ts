import { IMessageSDK } from "@photon-ai/imessage-kit";
import { config } from "../config.js";

export async function sendBubbles(sdk: IMessageSDK, text: string): Promise<void> {
  const bubbles = text
    .split("[SPLIT]")
    .map((s) => s.trim())
    .filter(Boolean);

  for (let i = 0; i < bubbles.length; i++) {
    await sdk.send({ to: config().USER_PHONE, text: bubbles[i] });
    if (i < bubbles.length - 1) {
      await sleep(1500);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
