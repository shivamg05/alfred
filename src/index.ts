// Load .env from project root regardless of cwd — needed when running as a
// different macOS user whose home dir differs from the project location.
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
const __envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
loadEnv({ path: __envPath });
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
import { classifyIntent } from "./orchestrator/classifier.js";
import { sendBubbles } from "./orchestrator/response.js";
import { checkDueReminders, registerCronJobs } from "./proactive/engine.js";

// ---------------------------------------------------------------------------
// Session buffer — batches messages before extraction for richer context
// (Supermemory insight: extracting from a session gives better coreference
//  resolution and more contextual facts than per-message extraction)
// ---------------------------------------------------------------------------
const SESSION_MAX = 5;                   // flush after this many messages
const SESSION_IDLE_MS = 2 * 60 * 1000;  // or after 2 min of silence

interface BufferedMsg { text: string; messageId: number }
const sessionBuffer: BufferedMsg[] = [];
let sessionTimer: ReturnType<typeof setTimeout> | null = null;

function flushExtractionBuffer(): void {
  if (sessionBuffer.length === 0) return;
  const batch = sessionBuffer.splice(0);
  const sessionText = batch.map((m) => m.text).join("\n");
  const lastMessageId = batch[batch.length - 1].messageId;
  console.log(`[alfred] extraction flush (${batch.length} messages)`);
  extractFromMessage({
    messageText: sessionText,
    messageId: lastMessageId,
    documentDate: new Date().toISOString(),
  }).catch((err) => console.error("[alfred] extraction error:", err));
}

function queueForExtraction(text: string, messageId: number): void {
  sessionBuffer.push({ text, messageId });
  if (sessionTimer) clearTimeout(sessionTimer);
  if (sessionBuffer.length >= SESSION_MAX) {
    flushExtractionBuffer();
  } else {
    sessionTimer = setTimeout(flushExtractionBuffer, SESSION_IDLE_MS);
  }
}

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

      // Skip iMessage tapback reactions (Liked/Loved/Laughed at/etc.)
      const reactionPattern = /^(Liked|Loved|Disliked|Laughed at|Emphasized|Questioned)\s+[""\u201C\u201D]/i;
      if (msg.text && reactionPattern.test(msg.text.trim())) {
        console.log(`[alfred] skipping tapback reaction: "${msg.text.slice(0, 60)}"`);
        return;
      }

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

      // Classify intent — determines whether to reply at all and how long
      const mode = await classifyIntent(effectiveText);
      console.log(`[alfred] mode: ${mode}`);

      // For silent messages, occasionally send a brief acknowledgment (~50% of the time)
      if (mode === "silent" && Math.random() < 0.3) {
        const acks = ["👍", "👀", "ok", "gotcha"];
        const ack = acks[Math.floor(Math.random() * acks.length)];
        await sendBubbles(sdk, ack);
      }

      if (mode !== "silent") {
        // Small delay — gives iMessage time to deliver any trailing messages
        // (e.g. link previews, follow-up texts sent right after) before we respond
        await new Promise((resolve) => setTimeout(resolve, 500));
        console.log("[alfred] building context...");
        const systemPrompt = await buildContext(buffer, mode);
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
      }

      // Fire any due reminders triggered by this message
      checkDueReminders(sdk);

      // Queue for session-based extraction (batches up to 5 messages or 2 min idle)
      queueForExtraction(effectiveText, messageId);
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
