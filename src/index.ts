import "dotenv/config";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import type { Message } from "@photon-ai/imessage-kit";
import { config } from "./config.js";
import { db } from "./db/schema.js";
import { ConversationBuffer } from "./memory/shortTerm.js";
import { insertMessage, getRecentMessages } from "./memory/facts.js";
import { extractFromMessage } from "./memory/extractor.js";
import { classifyMessage, getEffectiveText } from "./ingestion/router.js";
import { transcribeAudio } from "./ingestion/transcription.js";
import { summarizeImage, summarizeFile } from "./ingestion/fileParser.js";
import { buildContext } from "./orchestrator/context.js";
import { chat } from "./orchestrator/llm.js";
import { sendBubbles } from "./orchestrator/response.js";
import { checkDueReminders, registerCronJobs } from "./proactive/engine.js";

async function main(): Promise<void> {
  const cfg = config();

  // Initialize DB
  db();
  console.log("[alfred] database ready");

  const sdk = new IMessageSDK({ databasePath: cfg.IMESSAGE_DB_PATH });
  console.log("[alfred] imessage-kit initialized");

  // Seed conversation buffer from DB
  const buffer = new ConversationBuffer();
  const recent = getRecentMessages(20);
  buffer.seed(
    recent.map((r) => ({
      role: "user" as const,
      content: r.content,
      timestamp: r.created_at,
    })),
  );
  console.log("[alfred] buffer seeded with", recent.length, "messages");

  // Register proactive cron jobs
  registerCronJobs(sdk);
  console.log("[alfred] cron jobs registered");

  // Start watching for messages
  sdk.startWatching({
    async onDirectMessage(msg: Message) {
      try {
      // Only process messages from the user (not from Alfred itself)
      if (msg.isFromMe) return;

      console.log(`[alfred] message received from ${msg.participant ?? msg.chatId}`);

      let transcript: string | undefined;
      let fileSummary: string | undefined;
      const type = classifyMessage(msg);

      // Handle attachments
      const attachmentPath = msg.attachments?.[0]?.localPath ?? undefined;
      if (type === "audio" && attachmentPath) {
        transcript = (await transcribeAudio(attachmentPath)) ?? undefined;
      } else if (type === "image" && attachmentPath) {
        fileSummary = (await summarizeImage(attachmentPath)) ?? undefined;
      } else if (type === "file" && attachmentPath) {
        fileSummary = (await summarizeFile(attachmentPath)) ?? undefined;
      }

      // Store raw message
      const messageId = insertMessage({
        imessage_row_id: msg.rowId,
        raw_text: msg.text ?? undefined,
        media_type: type,
        transcript,
        file_summary: fileSummary,
      });

      const effectiveText = getEffectiveText(msg, transcript, fileSummary);

      // Add to conversation buffer
      buffer.push({
        role: "user",
        content: effectiveText,
        timestamp: new Date().toISOString(),
      });

      // Build context and respond
      console.log("[alfred] building context...");
      const systemPrompt = await buildContext(buffer);
      console.log("[alfred] calling LLM...");
      const reply = await chat(systemPrompt, effectiveText);
      console.log("[alfred] reply:", reply);

      await sendBubbles(sdk, reply);
      console.log("[alfred] sent reply");

      // Add Alfred's reply to buffer
      buffer.push({
        role: "assistant",
        content: reply.replace(/\[SPLIT\]/g, " "),
        timestamp: new Date().toISOString(),
      });

      // Fire any due reminders triggered by this message
      checkDueReminders(sdk);

      // Background: extract memory facts (don't await — keep response fast)
      extractFromMessage({
        messageText: effectiveText,
        messageId,
        documentDate: new Date().toISOString(),
      }).catch((err) => console.error("[alfred] extraction error:", err));
      } catch (err) {
        console.error("[alfred] handler error:", err);
      }
    },
  });

  console.log(`[alfred] watching for messages on ${cfg.ALFRED_PHONE} → replying to ${cfg.USER_PHONE}`);
}

main().catch((err) => {
  console.error("[alfred] fatal:", err);
  process.exit(1);
});
