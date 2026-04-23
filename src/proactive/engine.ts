import cron from "node-cron";
import type { IMessageSDK } from "@photon-ai/imessage-kit";
import {
  getDueReminders,
  markReminderFired,
  getDynamicProfileFacts,
  getStaticProfileFacts,
  logProactive,
} from "../memory/facts.js";
import { shouldSendProactive } from "./gate.js";
import { sendBubbles } from "../orchestrator/response.js";
import { generateProactive } from "../orchestrator/llm.js";
import { buildSystemPrompt } from "../tone/systemPrompt.js";
import { retrieveContext } from "../memory/retrieval.js";

async function makeProactiveSystemPrompt(): Promise<string> {
  const ctx = await retrieveContext("what should i check in with them about");
  return buildSystemPrompt(ctx, []);
}

export function checkDueReminders(sdk: IMessageSDK): void {
  const due = getDueReminders();
  for (const reminder of due) {
    const text = `hey don't forget — ${reminder.text}`;
    if (shouldSendProactive(text)) {
      sendBubbles(sdk, text).catch(console.error);
      logProactive("reminder", text);
    }
    markReminderFired(reminder.id);
  }
}

export function registerCronJobs(sdk: IMessageSDK): void {
  // morning brief — 9am
  cron.schedule("0 9 * * *", async () => {
    const systemPrompt = await makeProactiveSystemPrompt();
    const dynamic = getDynamicProfileFacts();
    if (dynamic.length === 0) return;
    const trigger = `morning check-in. relevant context: ${dynamic.slice(0, 3).join("; ")}`;
    const msg = await generateProactive(systemPrompt, trigger);
    if (shouldSendProactive(msg)) {
      await sendBubbles(sdk, msg);
      logProactive("morning_brief", msg);
    }
  });

  // midday pulse — 1pm (surface a relevant memory)
  cron.schedule("0 13 * * *", async () => {
    const systemPrompt = await makeProactiveSystemPrompt();
    const ctx = await retrieveContext("something interesting from the past worth remembering");
    if (ctx.retrieved.length === 0) return;
    const trigger = `surface one connection from the past that might be interesting to bring up: "${ctx.retrieved[0]}"`;
    const msg = await generateProactive(systemPrompt, trigger);
    if (shouldSendProactive(msg)) {
      await sendBubbles(sdk, msg);
      logProactive("midday_pulse", msg);
    }
  });

  // evening wrap — 7pm (overdue reminders + inactivity check)
  cron.schedule("0 19 * * *", async () => {
    const systemPrompt = await makeProactiveSystemPrompt();
    const dynamic = getDynamicProfileFacts();
    const trigger = `evening check-in. wrap up the day and check in: ${dynamic.slice(0, 2).join("; ")}`;
    const msg = await generateProactive(systemPrompt, trigger);
    if (shouldSendProactive(msg)) {
      await sendBubbles(sdk, msg);
      logProactive("evening_wrap", msg);
    }
  });
}
