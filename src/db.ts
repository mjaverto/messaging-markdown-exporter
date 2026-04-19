import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { ExportMessage } from "./types.js";

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1, 0, 0, 0);

function appleTimeToDate(raw: string): Date {
  const numeric = Number(raw || 0);
  const seconds = numeric > 10_000_000_000 ? numeric / 1_000_000_000 : numeric;
  return new Date(APPLE_EPOCH_MS + seconds * 1000);
}

function extractText(text: string, attributedBodyBase64: string): string {
  if (text?.trim()) return text.trim();
  if (!attributedBodyBase64) return "";
  const raw = Buffer.from(attributedBodyBase64, "base64").toString("utf8");
  const cleaned = raw.replace(/\u0000/g, " ").replace(/\s+/g, " ").trim();
  const nsStringMatch = cleaned.match(/NSString\s+(.+?)(?:\u0086|$)/);
  return (nsStringMatch?.[1] || cleaned).trim();
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

export function fetchMessages(options: {
  dbPath: string;
  start: Date;
  end: Date;
  myName: string;
  includeEmpty: boolean;
}): ExportMessage[] {
  const startApple = Math.floor((options.start.getTime() - APPLE_EPOCH_MS) * 1_000_000);
  const endApple = Math.floor((options.end.getTime() - APPLE_EPOCH_MS) * 1_000_000);

  const sql = `
.mode json
SELECT
  m.ROWID AS message_id,
  m.date AS message_date,
  m.is_from_me,
  COALESCE(m.text, '') AS text,
  COALESCE(hex(m.attributedBody), '') AS attributed_body_hex,
  COALESCE(m.service, '') AS service,
  COALESCE(a.attachment_count, 0) AS attachment_count,
  COALESCE(h.id, '') AS sender_handle,
  COALESCE(c.display_name, '') AS chat_display_name,
  COALESCE(GROUP_CONCAT(DISTINCT h2.id), '') AS participant_handles
FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN chat c ON c.ROWID = cmj.chat_id
LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
LEFT JOIN handle h2 ON h2.ROWID = chj.handle_id
LEFT JOIN (
  SELECT message_id, COUNT(*) AS attachment_count
  FROM message_attachment_join
  GROUP BY message_id
) a ON a.message_id = m.ROWID
WHERE m.date >= ${startApple} AND m.date < ${endApple}
GROUP BY m.ROWID
ORDER BY m.date ASC;
`;

  return withReadableCopy(options.dbPath, (safeDbPath) => {
    const output = execFileSync("sqlite3", [safeDbPath], { input: sql, encoding: "utf8" });
    const rows = JSON.parse(output) as Array<Record<string, string | number>>;
    return rows.flatMap((row) => {
      const attributedHex = String(row.attributed_body_hex || "");
      const attributedBodyBase64 = attributedHex ? Buffer.from(attributedHex, "hex").toString("base64") : "";
      const text = extractText(String(row.text || ""), attributedBodyBase64);
      const hadAttachments = Number(row.attachment_count || 0) > 0;
      if (!options.includeEmpty && !text && !hadAttachments) return [];
      const participants = String(row.participant_handles || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .sort();
      const isFromMe = Number(row.is_from_me || 0) === 1;
      return [{
        messageId: Number(row.message_id),
        timestamp: appleTimeToDate(String(row.message_date || "0")),
        sender: isFromMe ? options.myName : String(row.sender_handle || "Unknown"),
        text,
        isFromMe,
        service: String(row.service || "") || null,
        hadAttachments,
        chatDisplayName: String(row.chat_display_name || "") || null,
        participants,
      } satisfies ExportMessage];
    });
  });
}
