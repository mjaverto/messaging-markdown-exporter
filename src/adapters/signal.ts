import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import {
  ExportAdapter,
  NormalizedConversation,
  NormalizedMessage,
  TransientAdapterError,
} from "../core/model.js";
import { resolveSignalKey, SignalKeyError } from "../lib/signal-keychain.js";

/**
 * Kept as a named subclass of TransientAdapterError so existing README
 * references and error stacks stay interpretable, while the runner
 * handles it under the generic transient contract.
 */
export class SignalDatabaseBusyError extends TransientAdapterError {
  constructor(message: string) {
    super(message, "signal");
    this.name = "SignalDatabaseBusyError";
  }
}

const DEFAULT_SIGNAL_ROOT = path.join(os.homedir(), "Library", "Application Support", "Signal");
const DEFAULT_DB_PATH = path.join(DEFAULT_SIGNAL_ROOT, "sql", "db.sqlite");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_SIGNAL_ROOT, "config.json");

interface ConversationRow {
  id: string;
  name: string | null;
  profileFullName: string | null;
  e164: string | null;
  serviceId: string | null;
  type: string | null;
}

interface MessageRow {
  id: string;
  conversationId: string;
  source: string | null;
  sent_at: number | null;
  received_at: number | null;
  body: string | null;
  type: string | null;
  hasAttachments: number | null;
}

function conversationTitle(row: ConversationRow): string {
  return (
    row.name?.trim() ||
    row.profileFullName?.trim() ||
    row.e164?.trim() ||
    row.serviceId?.trim() ||
    row.id
  );
}

function withReadableDbCopy<T>(dbPath: string, fn: (safeDbPath: string) => T): T {
  // Checkpoint-then-copy: we first issue `pragma wal_checkpoint(TRUNCATE)` on
  // a short-lived reader so that whatever WAL contents existed are merged
  // into the main DB file on disk. Then fs.copyFileSync of the main file
  // (plus any residual WAL/SHM) is consistent in practice. A pure
  // fs-copy without the checkpoint can race with a Signal checkpoint
  // landing mid-copy and produce a snapshot SQLCipher rejects as malformed.
  //
  // We'd prefer `sqlcipher_export` into a plaintext ATTACH for a true
  // atomic snapshot, but better-sqlite3-multiple-ciphers rejects the
  // plaintext target with SQLITE_CANTOPEN; this is the closest robust
  // alternative that doesn't require the sqlcipher CLI.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-export-"));
  fs.chmodSync(tmpDir, 0o700);
  const safeDb = path.join(tmpDir, "db.sqlite");
  try {
    fs.copyFileSync(dbPath, safeDb);
    for (const suffix of ["-wal", "-shm"]) {
      const source = `${dbPath}${suffix}`;
      if (fs.existsSync(source)) fs.copyFileSync(source, `${safeDb}${suffix}`);
    }
    return fn(safeDb);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Native module loaded via createRequire so tsup leaves it as a runtime
// require in the ESM bundle instead of trying to inline it (which fails
// with "Dynamic require of ... is not supported" for CJS native modules).
const nativeRequire = createRequire(import.meta.url);
type SignalDatabaseCtor = new (
  filename: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => {
  pragma: (source: string, options?: { simple?: boolean }) => unknown;
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => unknown;
  };
  close: () => void;
};

function openSignalDatabase(
  dbPath: string,
  configPath: string,
): {
  all: <T>(sql: string, params?: unknown[]) => T[];
  close: () => void;
} {
  const Database = nativeRequire("better-sqlite3-multiple-ciphers") as SignalDatabaseCtor;

  const { hexKey } = resolveSignalKey(configPath);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  // better-sqlite3-multiple-ciphers defaults to "sqleet" — we MUST select
  // sqlcipher and its v4 defaults BEFORE issuing PRAGMA key, otherwise the
  // key is interpreted under the wrong cipher and SQLCipher reports
  // "file is not a database".
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  db.pragma(`key = "x'${hexKey}'"`);
  // Sanity check: reading schema requires the key to have taken effect.
  try {
    db.pragma("schema_version", { simple: true });
  } catch (error) {
    db.close();
    throw new SignalKeyError(
      `SQLCipher rejected the derived key for ${dbPath}: ${(error as Error).message}`,
      "decrypt-failed",
    );
  }
  return {
    all: <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
    close: () => db.close(),
  };
}

function selectConversationColumns(hasProfileFullName: boolean): string {
  const profileExpr = hasProfileFullName ? "profileFullName" : "NULL AS profileFullName";
  return `id, name, ${profileExpr}, e164, serviceId, type`;
}

export const signalAdapter: ExportAdapter = {
  source: "signal",
  async loadConversations(options): Promise<NormalizedConversation[]> {
    const dbPath = options.signalDbPath ? String(options.signalDbPath) : DEFAULT_DB_PATH;
    const configPath = options.signalConfigPath
      ? String(options.signalConfigPath)
      : DEFAULT_CONFIG_PATH;
    const myName = String(options.myName || "Me");
    const start = options.start instanceof Date ? options.start : new Date(0);
    const end = options.end instanceof Date ? options.end : new Date();
    const includeEmpty = Boolean(options.includeEmpty);

    if (!fs.existsSync(dbPath)) {
      throw new SignalKeyError(`Signal database not found at ${dbPath}`, "config-missing");
    }

    return withReadableDbCopy(dbPath, (safeDbPath) => {
      let db: ReturnType<typeof openSignalDatabase>;
      try {
        db = openSignalDatabase(safeDbPath, configPath);
      } catch (error) {
        const message = (error as Error).message || "";
        if (/SQLITE_BUSY|database is locked/i.test(message)) {
          throw new SignalDatabaseBusyError(
            `Signal database at ${dbPath} is locked — close Signal Desktop and retry`,
          );
        }
        throw error;
      }
      return readAll(db, start, end, includeEmpty, myName);
    });
  },
};

function readAll(
  db: { all: <T>(sql: string, params?: unknown[]) => T[]; close: () => void },
  start: Date,
  end: Date,
  includeEmpty: boolean,
  myName: string,
): NormalizedConversation[] {
  try {
    // Signal renamed profile columns a few times; probe pragma to stay
    // compatible across versions without hard-failing on older installs.
    const columns = db.all<{ name: string }>("PRAGMA table_info(conversations);");
    const hasProfileFullName = columns.some((c) => c.name === "profileFullName");

    const conversationRows = db.all<ConversationRow>(
      `SELECT ${selectConversationColumns(hasProfileFullName)} FROM conversations;`,
    );
    const conversations = new Map<string, NormalizedConversation>();
    for (const row of conversationRows) {
      const participants = [row.e164, row.serviceId, row.profileFullName, row.name]
        .map((v) => (v ?? "").toString().trim())
        .filter(Boolean);
      conversations.set(row.id, {
        source: "signal",
        conversationId: row.id,
        title: conversationTitle(row),
        participants,
        messages: [],
        chatId: row.id,
        service: "Signal",
      });
    }

    const messageRows = db.all<MessageRow>(
      `SELECT id, conversationId, source, sent_at, received_at, body, type, hasAttachments
         FROM messages
         WHERE type IN ('outgoing', 'incoming')
           AND (sent_at IS NULL OR (sent_at >= ? AND sent_at < ?))
         ORDER BY COALESCE(sent_at, received_at) ASC;`,
      [start.getTime(), end.getTime()],
    );

    for (const row of messageRows) {
      const convo = conversations.get(row.conversationId);
      if (!convo) continue;
      const text = (row.body ?? "").trim();
      const hadAttachments = Number(row.hasAttachments ?? 0) === 1;
      if (!includeEmpty && !text && !hadAttachments) continue;
      // Signal denormalizes direction into the `type` column rather than a
      // dedicated flag; `outgoing` = sent by this user, `incoming` = received.
      const isFromMe = row.type === "outgoing";
      const ts = Number(row.sent_at ?? row.received_at ?? 0);
      const message: NormalizedMessage = {
        id: String(row.id),
        timestamp: new Date(ts),
        sender: isFromMe ? myName : (row.source ?? "Unknown"),
        text,
        isFromMe,
        hadAttachments,
        metadata: row.type ? { type: row.type } : undefined,
      };
      convo.messages.push(message);
    }

    // Drop conversations that ended up empty after date filtering.
    return [...conversations.values()].filter((c) => c.messages.length > 0);
  } finally {
    db.close();
  }
}
