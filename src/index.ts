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
import { summarizeImageFromPath, summarizeFile } from "./ingestion/fileParser.js";
import { fetchContext, buildPrompt } from "./orchestrator/context.js";
import { chat } from "./orchestrator/llm.js";
import { classifyWithTimeout } from "./orchestrator/classifier.js";
import { sendBubbles } from "./orchestrator/response.js";
import { checkDueReminders, registerCronJobs } from "./proactive/engine.js";
import { resolveAttachment } from "./ingestion/attachments.js";
import { embedUnindexedFacts } from "./memory/vectors.js";
import type { ResponseMode } from "./orchestrator/classifier.js";

// ---------------------------------------------------------------------------
// Session buffer — batches messages before extraction for richer context
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

// ---------------------------------------------------------------------------
// Response debounce — simulates "wait for user to finish typing"
//
// iMessage has no typing-indicator API, so we approximate it: each incoming
// message is processed immediately (stored, classified, buffered) but the LLM
// response is deferred by RESPONSE_DEBOUNCE_MS. If another message arrives
// within that window, it's bundled and the timer resets. When the window
// closes, Alfred responds once to the combined batch.
// ---------------------------------------------------------------------------
const RESPONSE_DEBOUNCE_MS = 1000;

interface PendingResponse {
  text: string;
  modePromise: Promise<ResponseMode>;
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

  // Embed any facts that were saved without embeddings (ChromaDB was down during extraction)
  embedUnindexedFacts().catch((err) =>
    console.error("[alfred] startup embed failed:", err),
  );

  // Register proactive cron jobs
  registerCronJobs(sdk);
  console.log("[alfred] cron jobs registered");

  // --- Response debounce state (per-process, single user) ---
  const pendingResponses: PendingResponse[] = [];
  let responseTimer: ReturnType<typeof setTimeout> | null = null;

  async function flushResponseBuffer(): Promise<void> {
    if (pendingResponses.length === 0) return;
    const batch = pendingResponses.splice(0);

    // Combine all messages into one context string
    const combinedText = batch.map((m) => m.text).join("\n");

    // Resolve classifier + retrieval in parallel
    const t0 = Date.now();
    const [modes, contextData] = await Promise.all([
      Promise.all(batch.map((m) => m.modePromise)),
      fetchContext(buffer),
    ]);

    // Escalate to the highest-priority mode across all messages
    const mode: ResponseMode =
      modes.some((m) => m === "full") ? "full" :
      modes.some((m) => m === "brief") ? "brief" :
      "silent";

    console.log(`[alfred] responding to ${batch.length} message(s) as ${mode}`);

    if (mode === "silent") {
      if (Math.random() < 0.3) {
        const acks = ["👍", "👀", "ok", "gotcha"];
        await sendBubbles(sdk, acks[Math.floor(Math.random() * acks.length)]);
      }
      return;
    }

    try {
      const systemPrompt = buildPrompt(contextData, mode);
      const tContext = Date.now();
      const reply = await chat(systemPrompt, combinedText);
      const tLLM = Date.now();
      await sendBubbles(sdk, reply);
      const tSend = Date.now();
      console.log(`[alfred] timings — classify+context:${tContext - t0}ms llm:${tLLM - tContext}ms send:${tSend - tLLM}ms total:${tSend - t0}ms`);
      console.log("[alfred] reply:", reply);

      buffer.push({
        role: "assistant",
        content: reply.replace(/\[SPLIT\]/g, " "),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[alfred] response error:", err);
    }
  }

  function scheduleResponse(text: string, modePromise: Promise<ResponseMode>): void {
    pendingResponses.push({ text, modePromise });
    if (responseTimer) clearTimeout(responseTimer);
    responseTimer = setTimeout(() => {
      flushResponseBuffer().catch((err) =>
        console.error("[alfred] flush error:", err),
      );
    }, RESPONSE_DEBOUNCE_MS);
  }

  // Start watching for messages
  sdk.startWatching({
    async onDirectMessage(msg: Message) {
      try {
        // Only process messages from the user (not from Alfred itself)
        if (msg.isFromMe) return;

        // Use SDK's reaction field (covers all tapback types reliably)
        if (msg.reaction !== null) {
          console.log(`[alfred] skipping reaction from ${msg.participant}`);
          return;
        }

        console.log(`[alfred] message received from ${msg.participant ?? msg.chatId}`);

        // \ufffc is iMessage's object-replacement character — placeholder for attachments.
        // Strip it to get the real human text (may be empty for image-only messages).
        const ATTACH_CHAR = "\uFFFC";
        const hasPlaceholder = msg.text?.includes(ATTACH_CHAR) ?? false;
        const plainText = (msg.text ?? "").replace(/\uFFFC/g, "").trim();

        console.log(`[alfred] msg debug: text=${JSON.stringify(msg.text?.slice(0,40))} plain="${plainText.slice(0,40)}" hasPlaceholder=${hasPlaceholder} hasAttachments=${msg.hasAttachments} attachments=${msg.attachments?.length ?? "undef"}`);

        let transcript: string | undefined;
        let fileSummary: string | undefined;
        let type = classifyMessage(msg);

        let attachmentPath: string | undefined = msg.attachments?.[0]?.localPath ?? undefined;
        let attachmentMime: string = msg.attachments?.[0]?.mimeType ?? "";

        // Trigger fallback when:
        // - SDK gave empty attachments AND
        // - message has attachment placeholder char OR no real text (image-only)
        const looksLikeMedia = msg.attachments.length === 0 && (hasPlaceholder || !plainText);
        if (!attachmentPath && (msg.hasAttachments || looksLikeMedia)) {
          console.log(`[alfred] querying chat.db for attachments (rowId: ${msg.rowId}, hasAttachments=${msg.hasAttachments}, looksLikeMedia=${looksLikeMedia})`);
          const resolved = await resolveAttachment(msg.rowId);
          if (resolved) {
            attachmentPath = resolved.localPath;
            attachmentMime = resolved.mimeType;
            const mime = attachmentMime.toLowerCase();
            const p = attachmentPath.toLowerCase();
            if (mime.startsWith("audio/") || /\.(caf|m4a|mp3)$/.test(p)) type = "audio";
            else if (mime.startsWith("image/") || /\.(jpg|jpeg|png|gif|heic|heif|webp)$/.test(p)) type = "image";
            else type = "file";
          }
        }

        if (attachmentPath) {
          console.log(`[alfred] attachment: type=${type} path=${attachmentPath} mime=${attachmentMime}`);
        }

        // Handle attachments
        if (type === "audio" && attachmentPath) {
          transcript = (await transcribeAudio(attachmentPath)) ?? undefined;
        } else if (type === "image" && attachmentPath) {
          fileSummary = (await summarizeImageFromPath(attachmentPath)) ?? undefined;
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

        // Add to conversation buffer immediately (before response debounce)
        buffer.push({
          role: "user",
          content: effectiveText,
          timestamp: new Date().toISOString(),
        });

        // Fire classifier immediately (non-blocking) — runs in parallel with retrieval
        const modePromise: Promise<ResponseMode> = (transcript || fileSummary)
          ? Promise.resolve("full" as const)
          : classifyWithTimeout(effectiveText);

        // Queue for debounced response — resets timer if user sends another
        // message within RESPONSE_DEBOUNCE_MS (simulates typing detection)
        scheduleResponse(effectiveText, modePromise);

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
