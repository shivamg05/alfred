import type { Message } from "@photon-ai/imessage-kit";

export type MessageType = "text" | "audio" | "image" | "file" | "unknown";

export function classifyMessage(msg: Message): MessageType {
  const attachment = msg.attachments?.[0];
  if (!attachment) return "text";

  const mime = attachment.mimeType?.toLowerCase() ?? "";
  const path = (attachment.localPath ?? "").toLowerCase();

  if (mime.startsWith("audio/") || path.endsWith(".caf") || path.endsWith(".m4a") || path.endsWith(".mp3")) {
    return "audio";
  }
  if (mime.startsWith("image/") || /\.(jpg|jpeg|png|gif|heic|webp)$/.test(path)) {
    return "image";
  }
  if (mime.includes("pdf") || mime.includes("msword") || mime.includes("officedocument") || /\.(pdf|docx|doc|txt)$/.test(path)) {
    return "file";
  }
  return "unknown";
}

export function getEffectiveText(
  msg: Message,
  transcript?: string,
  fileSummary?: string,
  mediaType?: MessageType,
): string {
  // Strip iMessage's object-replacement character (attachment placeholder)
  const cleanText = (msg.text ?? "").replace(/\uFFFC/g, "").trim();

  if (transcript) return `[voice message]: ${transcript}`;
  if (fileSummary) {
    const label = mediaType === "file" ? "file" : "image";
    return cleanText ? `${cleanText}\n[${label}: ${fileSummary}]` : `[${label}: ${fileSummary}]`;
  }
  return cleanText || "[unsupported attachment]";
}
