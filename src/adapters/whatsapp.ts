import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ContactsMap, loadContactsMap, resolveHandle } from "../contacts.js";
import {
  ExportAdapter,
  NormalizedAttachment,
  NormalizedConversation,
  NormalizedMessage,
  TransientAdapterError,
} from "../core/model.js";

const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;
const DEFAULT_DB_PATH =
  "~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite";

export { DEFAULT_DB_PATH as WHATSAPP_DEFAULT_DB_PATH };

/**
 * Convert a Core Data / Mac epoch timestamp (seconds since 2001-01-01 UTC)
 * to a JS Date. WhatsApp stores ZMESSAGEDATE as REAL seconds.
 */
export function macEpochToDate(raw: number | string | null | undefined): Date {
  const n = Number(raw || 0);
  return new Date((n + APPLE_EPOCH_OFFSET_SECONDS) * 1000);
}

export interface ParsedJid {
  /** Digits-only user portion (e.g. "15705551234"). Empty for malformed input. */
  user: string;
  /** Server portion (e.g. "s.whatsapp.net", "g.us", "broadcast"). */
  server: string;
  /** True if the JID is a group (`@g.us`). */
  isGroup: boolean;
  /**
   * For participant JIDs in groups, WhatsApp often encodes
   * `<authorUser>_<chatId>@g.us` — expose the inner author if present.
   */
  groupAuthor?: string;
}

/**
 * Parse a WhatsApp JID. Non-group JIDs look like `15705551234@s.whatsapp.net`.
 * Group JIDs look like `15705551234-1234567890@g.us`. Participant-in-group JIDs
 * sometimes arrive as `15705551234_1234567890@g.us`; the leading segment is
 * the author's phone number.
 */
export function parseJid(raw: string | null | undefined): ParsedJid {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return { user: "", server: "", isGroup: false };
  const at = trimmed.lastIndexOf("@");
  const userPart = at >= 0 ? trimmed.slice(0, at) : trimmed;
  const server = at >= 0 ? trimmed.slice(at + 1) : "";
  const isGroup = server === "g.us";
  let groupAuthor: string | undefined;
  if (isGroup && userPart.includes("_")) {
    groupAuthor = userPart.split("_")[0];
  }
  const user = (groupAuthor || userPart).replace(/\D+/g, "");
  return { user, server, isGroup, groupAuthor };
}

/**
 * Convenience: extract a phone/handle suitable for Contacts-map lookup.
 * Returns the numeric author for participant JIDs, or the bare user for 1:1.
 */
export function jidToHandle(raw: string | null | undefined): string {
  const parsed = parseJid(raw);
  return parsed.user;
}

function copyDbForRead(dbPath: string): { safeDb: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-export-"));
  const safeDb = path.join(tmpDir, "ChatStorage.sqlite");
  // VACUUM INTO produces a point-in-time consistent snapshot even while
  // WhatsApp Desktop is actively writing. A naive fs.copyFileSync of
  // db + -wal + -shm can race: if a checkpoint lands between the copies,
  // the snapshot contains a WAL that references pages the main DB doesn't
  // have, and opening it throws "database disk image is malformed".
  try {
    execFileSync("sqlite3", [dbPath, `VACUUM INTO '${safeDb.replace(/'/g, "''")}'`], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/locked|busy/i.test(message)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw new TransientAdapterError(
        `WhatsApp database at ${dbPath} is locked (${message}). ` +
          `Quit WhatsApp Desktop or retry on the next scheduled tick.`,
        "whatsapp",
      );
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
  return {
    safeDb,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function runSqliteJson<T>(dbPath: string, sql: string): T[] {
  const output = execFileSync("sqlite3", [dbPath], {
    input: `.mode json\n${sql}`,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
  const trimmed = output.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed) as T[];
}

interface ChatRow {
  chat_pk: number;
  contact_jid: string;
  partner_name: string | null;
  session_type: number;
}

interface MessageRow {
  message_pk: number;
  message_date: number;
  is_from_me: number;
  text: string | null;
  from_jid: string | null;
  to_jid: string | null;
  pushname: string | null;
  group_member_name: string | null;
  group_member_firstname: string | null;
  group_member_jid: string | null;
  media_local_path: string | null;
  message_type: number;
}

interface PushNameRow {
  jid: string;
  pushname: string;
}

function kindFromMediaPath(p: string | null): NormalizedAttachment["kind"] {
  if (!p) return "other";
  const ext = path.extname(p).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".m4v", ".3gp"].includes(ext)) return "video";
  if ([".mp3", ".m4a", ".ogg", ".opus", ".wav", ".aac"].includes(ext)) return "audio";
  if ([".pdf", ".doc", ".docx", ".txt"].includes(ext)) return "document";
  return "other";
}

function resolveSender(
  row: MessageRow,
  pushMap: Map<string, string>,
  contacts: ContactsMap | undefined,
  myName: string,
): string {
  if (Number(row.is_from_me) === 1) return myName;

  const senderJidRaw = row.group_member_jid || row.from_jid || "";
  const parsed = parseJid(senderJidRaw);

  if (row.group_member_name && row.group_member_name.trim()) return row.group_member_name.trim();

  const pushFromRow = (row.pushname || "").trim();
  if (pushFromRow) return pushFromRow;

  const pushFromMap = senderJidRaw ? pushMap.get(senderJidRaw) : undefined;
  if (pushFromMap) return pushFromMap;

  if (contacts && parsed.user) {
    const resolved = resolveHandle(parsed.user, contacts);
    if (resolved && resolved !== parsed.user) return resolved;
  }

  if (row.group_member_firstname && row.group_member_firstname.trim())
    return row.group_member_firstname.trim();

  return parsed.user || senderJidRaw || "Unknown";
}

export const whatsappAdapter: ExportAdapter = {
  source: "whatsapp",
  async loadConversations(options): Promise<NormalizedConversation[]> {
    const dbPath = String(options.whatsappDbPath || options.dbPath || "");
    if (!dbPath) throw new Error("WhatsApp adapter: dbPath is required");
    if (!fs.existsSync(dbPath)) {
      console.error(
        `[whatsapp] Database not found at ${dbPath}. WhatsApp Desktop must be installed and FDA granted.`,
      );
      process.exit(1);
    }

    const myName = String(options.myName || "Me");
    const start = options.start instanceof Date ? options.start : new Date(0);
    const end = options.end instanceof Date ? options.end : new Date();
    const includeEmpty = Boolean(options.includeEmpty);
    const startMac = start.getTime() / 1000 - APPLE_EPOCH_OFFSET_SECONDS;
    const endMac = end.getTime() / 1000 - APPLE_EPOCH_OFFSET_SECONDS;

    const useContacts = options.useContacts !== false;
    const contacts: ContactsMap | undefined = useContacts ? await loadContactsMap() : undefined;

    const { safeDb, cleanup } = copyDbForRead(dbPath);
    try {
      let chats: ChatRow[];
      try {
        chats = runSqliteJson<ChatRow>(
          safeDb,
          `SELECT
             Z_PK AS chat_pk,
             COALESCE(ZCONTACTJID, '') AS contact_jid,
             ZPARTNERNAME AS partner_name,
             COALESCE(ZSESSIONTYPE, 0) AS session_type
           FROM ZWACHATSESSION
           ORDER BY Z_PK ASC;`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/locked|busy/i.test(message)) {
          throw new TransientAdapterError(
            `WhatsApp database is locked even after copy (${message}). ` +
              `Quit WhatsApp Desktop or retry on the next scheduled tick.`,
            "whatsapp",
          );
        }
        throw error;
      }

      const pushNames = runSqliteJson<PushNameRow>(
        safeDb,
        `SELECT ZJID AS jid, ZPUSHNAME AS pushname FROM ZWAPROFILEPUSHNAME;`,
      );
      const pushMap = new Map<string, string>();
      for (const row of pushNames) {
        if (row.jid && row.pushname) pushMap.set(row.jid, row.pushname);
      }

      const conversations: NormalizedConversation[] = [];
      for (const chat of chats) {
        const messages = runSqliteJson<MessageRow>(
          safeDb,
          `SELECT
             m.Z_PK AS message_pk,
             COALESCE(m.ZMESSAGEDATE, 0) AS message_date,
             COALESCE(m.ZISFROMME, 0) AS is_from_me,
             m.ZTEXT AS text,
             m.ZFROMJID AS from_jid,
             m.ZTOJID AS to_jid,
             m.ZPUSHNAME AS pushname,
             gm.ZCONTACTNAME AS group_member_name,
             gm.ZFIRSTNAME AS group_member_firstname,
             gm.ZMEMBERJID AS group_member_jid,
             mi.ZMEDIALOCALPATH AS media_local_path,
             COALESCE(m.ZMESSAGETYPE, 0) AS message_type
           FROM ZWAMESSAGE m
           LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
           LEFT JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM
           WHERE m.ZCHATSESSION = ${chat.chat_pk}
             AND m.ZMESSAGEDATE >= ${startMac}
             AND m.ZMESSAGEDATE < ${endMac}
           ORDER BY m.ZMESSAGEDATE ASC;`,
        );

        const participantSet = new Set<string>();
        const normalizedMessages: NormalizedMessage[] = [];
        for (const row of messages) {
          const text = String(row.text || "").trim();
          const mediaPath = row.media_local_path;
          const hasMedia = Boolean(mediaPath);
          if (!includeEmpty && !text && !hasMedia) continue;

          const sender = resolveSender(row, pushMap, contacts, myName);
          if (!Number(row.is_from_me)) participantSet.add(sender);

          const attachments: NormalizedAttachment[] | undefined = hasMedia
            ? [
                {
                  path: mediaPath || undefined,
                  name: mediaPath ? path.basename(mediaPath) : undefined,
                  kind: kindFromMediaPath(mediaPath),
                },
              ]
            : undefined;

          normalizedMessages.push({
            id: String(row.message_pk),
            timestamp: macEpochToDate(row.message_date),
            sender,
            text,
            isFromMe: Number(row.is_from_me) === 1,
            hadAttachments: hasMedia,
            attachments,
          });
        }

        if (normalizedMessages.length === 0 && !includeEmpty) continue;

        const parsedChat = parseJid(chat.contact_jid);
        const fallbackTitle = parsedChat.isGroup
          ? `Group ${chat.contact_jid}`
          : parsedChat.user || chat.contact_jid || `Chat ${chat.chat_pk}`;
        const title = (chat.partner_name && chat.partner_name.trim()) || fallbackTitle;

        conversations.push({
          source: "whatsapp",
          conversationId: chat.contact_jid || `chat-${chat.chat_pk}`,
          title,
          participants: [...participantSet].sort(),
          messages: normalizedMessages,
          chatId: chat.chat_pk,
          service: "WhatsApp",
        });
      }
      return conversations;
    } finally {
      cleanup();
    }
  },
};
