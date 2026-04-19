import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ExportAdapter, NormalizedAttachment, NormalizedConversation, NormalizedMessage } from "../core/model.js";

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1, 0, 0, 0);

function appleTimeToDate(raw: string): Date {
  const numeric = Number(raw || 0);
  const seconds = numeric > 10_000_000_000 ? numeric / 1_000_000_000 : numeric;
  return new Date(APPLE_EPOCH_MS + seconds * 1000);
}

function cleanDecodedText(input: string): string {
  return input
    .replace(/streamtyped/gi, "")
    .replace(/NSMutableAttributedString|NSAttributedString|NSMutableString|NSString|NSDictionary|NSNumber|NSValue|NSData|NSObject|NSURL/gi, " ")
    .replace(/__kIM[A-Za-z0-9_]+/g, " ")
    .replace(/bplist00/g, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeAttributedBodyHex(hex: string): string {
  if (!hex) return "";
  const buffer = Buffer.from(hex, "hex");
  const utf8 = buffer.toString("utf8").replace(/\u0000/g, " ");
  const nsStrings = [...utf8.matchAll(/NSString\s+([^\u0086]+?)(?=\s{2,}|__kIM|NSDictionary|$)/g)]
    .map((match) => cleanDecodedText(match[1] || ""))
    .filter((value): value is string => Boolean(value && value.trim()))
    .filter((value) => !/^at_0_[A-F0-9-]+$/i.test(value));
  if (nsStrings.length > 0) {
    const longest = nsStrings.sort((a, b) => b.length - a.length)[0];
    if (longest) return longest;
  }
  return cleanDecodedText(utf8);
}

function withReadableCopy<T>(dbPath: string, fn: (safeDbPath: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "imessage-export-"));
  const safeDb = path.join(tmpDir, "chat.db");
  fs.copyFileSync(dbPath, safeDb);
  for (const suffix of ["-wal", "-shm"]) {
    const source = `${dbPath}${suffix}`;
    if (fs.existsSync(source)) fs.copyFileSync(source, `${safeDb}${suffix}`);
  }
  try {
    return fn(safeDb);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function inferAttachmentKind(mimeType: string | null): NormalizedAttachment["kind"] {
  if (!mimeType) return "other";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.includes("pdf") || mimeType.includes("text") || mimeType.includes("application")) return "document";
  return "other";
}

export const iMessageAdapter: ExportAdapter = {
  source: "imessage",
  async loadConversations(options): Promise<NormalizedConversation[]> {
    const dbPath = String(options.dbPath);
    const myName = String(options.myName || "Me");
    const start = options.start instanceof Date ? options.start : new Date(Date.now() - 86400000);
    const end = options.end instanceof Date ? options.end : new Date();
    const includeEmpty = Boolean(options.includeEmpty);
    const startApple = Math.floor((start.getTime() - APPLE_EPOCH_MS) * 1_000_000);
    const endApple = Math.floor((end.getTime() - APPLE_EPOCH_MS) * 1_000_000);

    const sql = `
.mode json
SELECT
  m.ROWID AS message_id,
  m.date AS message_date,
  m.is_from_me,
  COALESCE(m.text, '') AS text,
  COALESCE(hex(m.attributedBody), '') AS attributed_body_hex,
  COALESCE(h.id, '') AS sender_handle,
  COALESCE(c.ROWID, 0) AS chat_id,
  COALESCE(c.guid, '') AS chat_guid,
  COALESCE(c.display_name, '') AS chat_display_name,
  COALESCE(m.service, '') AS service,
  COALESCE(GROUP_CONCAT(DISTINCT h2.id), '') AS participant_handles,
  COALESCE(GROUP_CONCAT(DISTINCT a.filename), '') AS attachment_files,
  COALESCE(GROUP_CONCAT(DISTINCT a.mime_type), '') AS attachment_mime_types,
  COALESCE(COUNT(DISTINCT a.ROWID), 0) AS attachment_count
FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN chat c ON c.ROWID = cmj.chat_id
LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
LEFT JOIN handle h2 ON h2.ROWID = chj.handle_id
LEFT JOIN message_attachment_join maj ON maj.message_id = m.ROWID
LEFT JOIN attachment a ON a.ROWID = maj.attachment_id
WHERE m.date >= ${startApple} AND m.date < ${endApple}
GROUP BY m.ROWID
ORDER BY m.date ASC;
`;

    return withReadableCopy(dbPath, (safeDbPath) => {
      const output = execFileSync("sqlite3", [safeDbPath], {
        input: sql,
        encoding: "utf8",
        // Default maxBuffer is 1 MiB, which overflows (ENOBUFS) on multi-year
        // date ranges where the JSON output can exceed 30 MB. Raise to 1 GiB.
        maxBuffer: 1024 * 1024 * 1024,
      });
      const rows = JSON.parse(output) as Array<Record<string, string | number>>;
      const conversations = new Map<string, NormalizedConversation>();
      for (const row of rows) {
        const text = String(row.text || "").trim() || decodeAttributedBodyHex(String(row.attributed_body_hex || ""));
        const attachmentCount = Number(row.attachment_count || 0);
        if (!includeEmpty && !text && attachmentCount === 0) continue;
        const participants = String(row.participant_handles || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
          .sort();
        const conversationId = String(row.chat_guid || row.chat_display_name || participants.join(",") || row.message_id);
        const title = String(row.chat_display_name || "") || participants.join(", ") || conversationId;
        const chatIdRaw = Number(row.chat_id || 0);
        const service = String(row.service || "") || null;
        const convo = conversations.get(conversationId) || {
          source: "imessage",
          conversationId,
          title,
          participants,
          messages: [],
          chatId: chatIdRaw > 0 ? chatIdRaw : null,
          service,
        } satisfies NormalizedConversation;
        if (!convo.service && service) convo.service = service;
        const isFromMe = Number(row.is_from_me || 0) === 1;
        const files = String(row.attachment_files || "").split(",").map((value) => value.trim()).filter(Boolean);
        const mimeTypes = String(row.attachment_mime_types || "").split(",").map((value) => value.trim()).filter(Boolean);
        const attachments: NormalizedAttachment[] = files.map((file, index) => ({
          path: file,
          name: path.basename(file),
          mimeType: mimeTypes[index] || undefined,
          kind: inferAttachmentKind(mimeTypes[index] || null),
        }));
        const message: NormalizedMessage = {
          id: String(row.message_id),
          timestamp: appleTimeToDate(String(row.message_date || "0")),
          sender: isFromMe ? myName : String(row.sender_handle || "Unknown"),
          text,
          isFromMe,
          hadAttachments: attachmentCount > 0,
          attachments,
        };
        convo.messages.push(message);
        conversations.set(conversationId, convo);
      }
      return [...conversations.values()];
    });
  },
};
