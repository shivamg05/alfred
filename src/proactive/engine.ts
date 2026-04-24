import cron from "node-cron";
import type { IMessageSDK } from "@photon-ai/imessage-kit";
import {
  getDueReminders,
  getStrictlyDueReminders,
  markReminderFired,
  getUpcomingEventFacts,
  logProactive,
} from "../memory/facts.js";
import { shouldSendProactive } from "./gate.js";
import { sendBubbles } from "../orchestrator/response.js";
import { chat } from "../orchestrator/llm.js";
import { fetchContext, buildPrompt } from "../orchestrator/context.js";
import { ConversationBuffer } from "../memory/shortTerm.js";
import { consolidateExpiredLevel0, promoteLevel1Patterns } from "../memory/consolidation.js";

const PROACTIVE_SUFFIX = `

YOU ARE INITIATING THIS MESSAGE UNPROMPTED. Rules:
- Only send if you have something genuinely useful or timely to say
- If there's nothing worth saying, reply with exactly: SKIP
- One bubble max. No questions unless it's the whole point.
- Don't announce that you're checking in. Just say the thing.`;

async function runProactiveChat(
  sdk: IMessageSDK,
  trigger: string,
  logType: string,
): Promise<void> {
  const emptyBuffer = new ConversationBuffer();
  const wantsTodoist = /\b(todoist|task|tasks|due|overdue)\b/i.test(trigger);
  const contextData = await fetchContext(emptyBuffer, { includeTodoist: wantsTodoist });
  const systemPrompt = buildPrompt(contextData, "full") + PROACTIVE_SUFFIX;

  const msg = await chat(systemPrompt, `[internal: ${trigger}]`, { allowTools: true });

  if (!msg || msg.trim() === "SKIP" || msg.toUpperCase().includes("SKIP")) {
    console.log(`[proactive] ${logType} → skipped`);
    return;
  }

  if (shouldSendProactive(msg)) {
    console.log(`[proactive] ${logType}: "${msg.slice(0, 80)}"`);
    await sendBubbles(sdk, msg);
    logProactive(logType, msg);
  }
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
  // Every minute — fire any reminders that are past due.
  cron.schedule("* * * * *", () => {
    const due = getStrictlyDueReminders();
    for (const reminder of due) {
      const text = `hey don't forget — ${reminder.text}`;
      if (shouldSendProactive(text)) {
        sendBubbles(sdk, text).catch(console.error);
        logProactive("reminder", text);
      }
      markReminderFired(reminder.id);
    }
  });

  // Every 6 hours — expire short-lived facts and consolidate repeated state/event evidence.
  cron.schedule("17 */6 * * *", async () => {
    await consolidateExpiredLevel0().catch(console.error);
  });

  // Weekly — promote supported behavioral patterns into identity/value memories.
  cron.schedule("30 3 * * 0", async () => {
    await promoteLevel1Patterns().catch(console.error);
  });

  // 9am — morning brief: today's tasks + upcoming events in next 7 days
  cron.schedule("0 9 * * *", async () => {
    const upcoming = getUpcomingEventFacts(7);
    const upcomingStr = upcoming.length > 0
      ? upcoming.map((f) => `${f.text}${f.event_date ? ` (${f.event_date})` : ""}`).join("; ")
      : "none";

    const trigger = `morning brief. check their todoist tasks for today using todoist_list_tasks. upcoming events from memory: ${upcomingStr}. if there's something worth flagging — an overdue task, something happening soon, anything they should know today — say it. otherwise SKIP.`;

    await runProactiveChat(sdk, trigger, "morning_brief").catch(console.error);
  });

  // 1pm — only fires if something is happening in the next 48 hours
  cron.schedule("0 13 * * *", async () => {
    const upcoming48h = getUpcomingEventFacts(2);
    if (upcoming48h.length === 0) {
      console.log("[proactive] midday_pulse → nothing upcoming, skipped");
      return;
    }

    const upcomingStr = upcoming48h
      .map((f) => `${f.text}${f.event_date ? ` (${f.event_date})` : ""}`)
      .join("; ");

    const trigger = `midday heads up. something is happening in the next 48 hours: ${upcomingStr}. send a brief, natural reminder if it's actually useful. otherwise SKIP.`;

    await runProactiveChat(sdk, trigger, "midday_pulse").catch(console.error);
  });

  // 7pm — evening: check open/overdue todoist tasks, only send if there's something real
  cron.schedule("0 19 * * *", async () => {
    const trigger = `evening check-in. use todoist_list_tasks with filter "today | overdue" to see what's still open. if there are overdue or incomplete tasks worth flagging, do it. if nothing meaningful is open, SKIP.`;

    await runProactiveChat(sdk, trigger, "evening_wrap").catch(console.error);
  });
}
