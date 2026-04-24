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
import { chat, SEARCH_ACKS } from "./orchestrator/llm.js";
import { classifyWithTimeout, generateContextualAck } from "./orchestrator/classifier.js";
import { sendBubbles } from "./orchestrator/response.js";
import { checkDueReminders, registerCronJobs } from "./proactive/engine.js";
import { resolveAttachment, resolveAttachments } from "./ingestion/attachments.js";
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
const PLAIN_RESPONSE_DEBOUNCE_MS = 2000;

interface PendingResponse {
  text: string;
  modePromise: Promise<ResponseMode>;
  receivedAt: number;
}

function likelyNeedsTool(text: string): boolean {
  const t = text.toLowerCase();
  return likelyNeedsTodoist(text) ||
    /\b(look up|search|google|weather|news|price|current|latest)\b/.test(t) ||
    /https?:\/\//.test(t);
}

function likelyNeedsTodoist(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(todo|task|to[- ]?do|due|overdue|caught up|anything i need to do|what do i have|schedule|remind|reminder)\b/.test(t);
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

    // Resolve the response gate first. Most messages should not get a reply;
    // avoid doing retrieval/tool context work when Alfred is going to stay quiet.
    const wallStart = batch[0].receivedAt;
    const t0 = Date.now();
    const modes = await Promise.all(batch.map((m) => m.modePromise));

    // Escalate to the highest-priority mode across all messages
    const mode: ResponseMode =
      modes.some((m) => m === "full") ? "full" :
      modes.some((m) => m === "brief") ? "brief" :
      modes.some((m) => m === "acknowledge") ? "acknowledge" :
      "silent";

    console.log(`[alfred] responding to ${batch.length} message(s) as ${mode} | input: "${combinedText.slice(0, 80)}"`);

    if (mode === "silent") {
      console.log(`[alfred] no response sent (classifier=silent)`);
      return;
    }

    if (mode === "acknowledge") {
      const recentForAck = buffer.getRecent(4).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
      const ack = await generateContextualAck(combinedText, recentForAck);
      await sendBubbles(sdk, ack);
      return;
    }

    try {
      const includeTodoist = mode === "full" && likelyNeedsTodoist(combinedText);
      const allowTools = mode === "full" && likelyNeedsTool(combinedText);
      const contextData = await fetchContext(buffer, { includeTodoist });
      const systemPrompt = buildPrompt(contextData, mode);
      const tContext = Date.now();
      const reply = await chat(systemPrompt, combinedText, {
        allowTools,
        maxTokens: mode === "brief" ? 120 : 200,
        onWebSearch: async () => {
          const ack = SEARCH_ACKS[Math.floor(Math.random() * SEARCH_ACKS.length)];
          console.log(`[alfred] web search ack: "${ack}"`);
          await sendBubbles(sdk, ack);
        },
      });
      const tLLM = Date.now();
      if (!reply || reply.trim() === "__NO_RESPONSE__") {
        console.log(`[alfred] no response sent (llm=${reply || "empty"})`);
        return;
      }
      await sendBubbles(sdk, reply);
      const tSend = Date.now();
      console.log(`[alfred] timings — classify+context:${tContext - t0}ms llm:${tLLM - tContext}ms send:${tSend - tLLM}ms total:${tSend - t0}ms wall:${tSend - wallStart}ms`);
      console.log(`[alfred] reply (${mode}): ${reply}`);

      buffer.push({
        role: "assistant",
        content: reply.replace(/\[SPLIT\]/g, " "),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[alfred] response error:", err);
    }
  }

  function scheduleResponse(text: string, modePromise: Promise<ResponseMode>, receivedAt: number, debounceMs: number): void {
    pendingResponses.push({ text, modePromise, receivedAt });
    if (responseTimer) clearTimeout(responseTimer);
    responseTimer = setTimeout(() => {
      flushResponseBuffer().catch((err) =>
        console.error("[alfred] flush error:", err),
      );
    }, debounceMs);
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

        // Collect all attachments — SDK path first, fallback to chat.db query
        interface RawAttachment { localPath: string; mimeType: string }
        let allAttachments: RawAttachment[] = (msg.attachments ?? [])
          .filter((a) => a.localPath)
          .map((a) => ({ localPath: a.localPath!, mimeType: a.mimeType ?? "" }));

        const looksLikeMedia = allAttachments.length === 0 && (hasPlaceholder || !plainText);
        if (allAttachments.length === 0 && (msg.hasAttachments || looksLikeMedia)) {
          console.log(`[alfred] querying chat.db for attachments (rowId: ${msg.rowId}, hasAttachments=${msg.hasAttachments}, looksLikeMedia=${looksLikeMedia})`);
          allAttachments = await resolveAttachments(msg.rowId);
        }

        // Classify by first attachment's type (audio/image/file are mutually exclusive per message)
        if (allAttachments.length > 0) {
          const mime = allAttachments[0].mimeType.toLowerCase();
          const p = allAttachments[0].localPath.toLowerCase();
          if (mime.startsWith("audio/") || /\.(caf|m4a|mp3)$/.test(p)) type = "audio";
          else if (mime.startsWith("image/") || /\.(jpg|jpeg|png|gif|heic|heif|webp)$/.test(p)) type = "image";
          else type = "file";
          console.log(`[alfred] ${allAttachments.length} attachment(s): type=${type}`);
        }

        // Handle attachments
        if (type === "audio" && allAttachments.length > 0) {
          transcript = (await transcribeAudio(allAttachments[0].localPath)) ?? undefined;
        } else if (type === "image" && allAttachments.length > 0) {
          const imagePaths = allAttachments
            .filter(({ localPath: p }) => /\.(jpg|jpeg|png|gif|heic|heif|webp)$/i.test(p) || allAttachments[0].mimeType.startsWith("image/"))
            .map((a) => a.localPath);
          const summaries = await Promise.all(imagePaths.map((p) => summarizeImageFromPath(p)));
          const valid = summaries.filter(Boolean) as string[];
          fileSummary = valid.length === 1
            ? valid[0]
            : valid.map((s, i) => `[Image ${i + 1}: ${s}]`).join(" ");
        } else if (type === "file" && allAttachments.length > 0) {
          fileSummary = (await summarizeFile(allAttachments[0].localPath)) ?? undefined;
        }

        // Store raw message
        const messageId = insertMessage({
          imessage_row_id: msg.rowId,
          raw_text: msg.text ?? undefined,
          media_type: type,
          transcript,
          file_summary: fileSummary,
        });

        const effectiveText = getEffectiveText(msg, transcript, fileSummary, type);

        // Add to conversation buffer immediately (before response debounce)
        buffer.push({
          role: "user",
          content: effectiveText,
          timestamp: new Date().toISOString(),
        });

        const receivedAt = Date.now();

        // Fire classifier immediately (non-blocking) — runs in parallel with retrieval
        // Pass last 3 messages so classifier understands follow-ups and continuations
        const recentForClassifier = buffer.getRecent(5).map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));
        const modePromise: Promise<ResponseMode> = (transcript || fileSummary)
          ? Promise.resolve("full" as const)
          : classifyWithTimeout(effectiveText, recentForClassifier);

        // Queue for debounced response — resets timer if user sends another
        // message within RESPONSE_DEBOUNCE_MS (simulates typing detection)
        const hasProcessedAttachment = type === "audio" || type === "image" || type === "file";
        const debounceMs = hasProcessedAttachment || likelyNeedsTool(effectiveText)
          ? RESPONSE_DEBOUNCE_MS
          : PLAIN_RESPONSE_DEBOUNCE_MS;
        scheduleResponse(effectiveText, modePromise, receivedAt, debounceMs);

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
