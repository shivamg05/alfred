/**
 * Fallback attachment resolver for the WAL race condition.
 *
 * The imessage-kit WAL watcher fires as soon as a message row appears in
 * chat.db, but the corresponding message_attachment_join rows may not have
 * flushed yet — so msg.attachments is [] even though msg.hasAttachments is
 * true. This module retries the attachment query directly against chat.db
 * after a short delay.
 */
import Database from "better-sqlite3";
import { homedir } from "os";
import { existsSync } from "fs";
import { config } from "../config.js";

export interface ResolvedAttachment {
  localPath: string;
  mimeType: string;
}

/** Expand `~/...` paths the same way imessage-kit does. */
function expandPath(filename: string): string {
  if (filename.startsWith("~")) return filename.replace("~", homedir());
  if (filename.startsWith("/")) return filename;
  return `${homedir()}/Library/Messages/Attachments/${filename}`;
}

/**
 * Wait up to `maxWaitMs` for the attachment rows to appear, then return all
 * non-sticker attachments. Accepts either a numeric ROWID or a guid string.
 */
export async function resolveAttachments(
  messageIdOrGuid: number | string,
  maxWaitMs = 5000,
): Promise<ResolvedAttachment[]> {
  const imsgDb = config().IMESSAGE_DB_PATH;
  const intervalMs = 500;
  const attempts = Math.ceil(maxWaitMs / intervalMs);

  const isNumeric = typeof messageIdOrGuid === "number";
  const whereClause = isNumeric
    ? "message_attachment_join.message_id = ?"
    : "message.guid = ? AND message_attachment_join.message_id = message.ROWID";
  const joinClause = isNumeric
    ? ""
    : "INNER JOIN message ON message.ROWID = message_attachment_join.message_id";

  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    try {
      const db = new Database(imsgDb, { readonly: true, fileMustExist: true });
      const sql = `
        SELECT attachment.filename, attachment.mime_type
        FROM attachment
        INNER JOIN message_attachment_join
          ON attachment.ROWID = message_attachment_join.attachment_id
        ${joinClause}
        WHERE ${whereClause}
          AND (attachment.hide_attachment IS NULL OR attachment.hide_attachment = 0)
          AND attachment.is_sticker = 0
        ORDER BY message_attachment_join.attachment_id ASC`;
      const rows = db.prepare(sql).all(messageIdOrGuid) as
        { filename: string; mime_type: string }[];
      db.close();

      const resolved = rows
        .map((row) => ({ localPath: expandPath(row.filename), mimeType: row.mime_type ?? "" }))
        .filter((r) => existsSync(r.localPath));

      if (resolved.length > 0) {
        console.log(`[attachments] resolved ${resolved.length} attachment(s) after ${(i + 1) * intervalMs}ms`);
        return resolved;
      }
    } catch {
      // DB locked or not ready — keep retrying
    }
  }

  console.warn(`[attachments] could not resolve attachments for ${messageIdOrGuid} after ${maxWaitMs}ms`);
  return [];
}

/** Convenience wrapper returning the first attachment (for audio/file). */
export async function resolveAttachment(
  messageIdOrGuid: number | string,
  maxWaitMs = 5000,
): Promise<ResolvedAttachment | null> {
  const all = await resolveAttachments(messageIdOrGuid, maxWaitMs);
  return all[0] ?? null;
}
