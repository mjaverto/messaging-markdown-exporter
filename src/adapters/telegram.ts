import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ExportAdapter, NormalizedConversation, NormalizedMessage } from "../core/model.js";

/**
 * Native Telegram adapter using MTProto via the `telegram` npm package
 * (gramjs). Persistent `StringSession` blobs let unattended cron jobs run
 * without a fresh login each time.
 *
 * One-time setup is handled by the `telegram-login` CLI subcommand
 * (see src/cli.ts) which writes:
 *   ~/.config/imessage-to-markdown/telegram/credentials.json  ({ apiId, apiHash })
 *   ~/.config/imessage-to-markdown/telegram/session.txt       (StringSession)
 *
 * Per-dialog read cursor lives at:
 *   ~/.config/imessage-to-markdown/telegram/cursors.json      ({ [dialogId]: maxMsgId })
 *
 * On `AUTH_KEY_UNREGISTERED` we exit 0 with a loud warning so cron does not
 * loop. On `FloodWaitError` we sleep `err.seconds` and retry once; if that
 * fails we save partial progress and exit 0.
 */

const CONFIG_DIR = path.join(os.homedir(), ".config", "imessage-to-markdown", "telegram");
const CREDENTIALS_PATH = path.join(CONFIG_DIR, "credentials.json");
const SESSION_PATH = path.join(CONFIG_DIR, "session.txt");
const CURSORS_PATH = path.join(CONFIG_DIR, "cursors.json");

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}

export function getTelegramConfigPaths(): {
  configDir: string;
  credentialsPath: string;
  sessionPath: string;
  cursorsPath: string;
} {
  return {
    configDir: CONFIG_DIR,
    credentialsPath: CREDENTIALS_PATH,
    sessionPath: SESSION_PATH,
    cursorsPath: CURSORS_PATH,
  };
}

export function loadCredentials(): TelegramCredentials {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Telegram credentials not found at ${CREDENTIALS_PATH}. Run \`node dist/cli.js telegram-login\` first.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8")) as TelegramCredentials;
  if (!raw.apiId || !raw.apiHash) {
    throw new Error("Telegram credentials.json is missing apiId or apiHash.");
  }
  return raw;
}

export function loadSession(): string {
  if (!fs.existsSync(SESSION_PATH)) {
    throw new Error(
      `Telegram session not found at ${SESSION_PATH}. Run \`node dist/cli.js telegram-login\` first.`,
    );
  }
  return fs.readFileSync(SESSION_PATH, "utf8").trim();
}

export function loadCursors(): Record<string, number> {
  if (!fs.existsSync(CURSORS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CURSORS_PATH, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

export function saveCursors(cursors: Record<string, number>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CURSORS_PATH, JSON.stringify(cursors, null, 2), { mode: 0o600 });
}

export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

export function writeCredentials(creds: TelegramCredentials): void {
  ensureConfigDir();
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function writeSession(session: string): void {
  ensureConfigDir();
  fs.writeFileSync(SESSION_PATH, session, { mode: 0o600 });
}

interface FloodWaitLike {
  seconds: number;
  errorMessage?: string;
}
function isFloodWait(err: unknown): err is FloodWaitLike {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { errorMessage?: string; className?: string; seconds?: number };
  return (
    typeof anyErr.seconds === "number" &&
    (anyErr.errorMessage === "FLOOD_WAIT" ||
      anyErr.className === "FloodWaitError" ||
      /flood.?wait/i.test(String(anyErr.errorMessage || "")))
  );
}

function isAuthInvalid(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_INVALID/.test(message);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Advance a cursor map: returns the new maxId for a dialog given the most
 * recent message id seen this run. Exported for unit tests.
 */
export function advanceCursor(
  cursors: Record<string, number>,
  dialogId: string,
  observedIds: number[],
): Record<string, number> {
  if (observedIds.length === 0) return cursors;
  const max = Math.max(...observedIds, cursors[dialogId] || 0);
  return { ...cursors, [dialogId]: max };
}

/**
 * Wrap a fetch in a single FloodWait-aware retry. Exported for unit tests
 * (the live adapter wraps real gramjs calls in this).
 */
export async function withFloodWaitRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isFloodWait(err)) throw err;
    const wait = Math.max(1, Number(err.seconds));
    console.warn(`[telegram] FloodWait ${wait}s, sleeping then retrying once...`);
    await sleep(wait * 1000);
    return await fn();
  }
}

export const telegramAdapter: ExportAdapter = {
  source: "telegram",
  async loadConversations(options): Promise<NormalizedConversation[]> {
    const myName = String(options.myName || "Me");
    const start = options.start instanceof Date ? options.start : new Date(0);
    const end = options.end instanceof Date ? options.end : new Date();
    const includeEmpty = Boolean(options.includeEmpty);

    const credentials = loadCredentials();
    const sessionString = loadSession();
    const cursors = loadCursors();

    // Lazy-import gramjs so vitest unit tests for cursor/floodwait helpers
    // do not pull in the whole MTProto runtime.
    const { TelegramClient } = await import("telegram");
    const { StringSession } = await import("telegram/sessions/index.js");

    const client = new TelegramClient(
      new StringSession(sessionString),
      credentials.apiId,
      credentials.apiHash,
      { connectionRetries: 5 },
    );

    try {
      await client.connect();
    } catch (err) {
      if (isAuthInvalid(err)) {
        console.warn(
          `[telegram] Session is no longer valid (${err instanceof Error ? err.message : String(err)}). ` +
            `Re-run \`node dist/cli.js telegram-login\`. Exiting cleanly.`,
        );
        return [];
      }
      throw err;
    }

    const conversations = new Map<string, NormalizedConversation>();
    let bailedEarly = false;

    try {
      const dialogs = [];
      for await (const dialog of client.iterDialogs({})) {
        dialogs.push(dialog);
      }

      for (const dialog of dialogs) {
        const dialogIdStr = String(dialog.id);
        const minId = Number(cursors[dialogIdStr] || 0);
        const observedIds: number[] = [];
        const messages: NormalizedMessage[] = [];

        try {
          const fetched = await withFloodWaitRetry(async () => {
            const out = [];
            // gramjs supports server-side date filtering via offsetDate; we
            // do client-side filtering after fetch for simplicity.
            for await (const msg of client.iterMessages(dialog.entity, { minId, limit: 1000 })) {
              out.push(msg);
            }
            return out;
          });

          for (const msg of fetched) {
            const id = Number(msg.id);
            observedIds.push(id);
            const ts = msg.date ? new Date(Number(msg.date) * 1000) : new Date();
            if (ts < start || ts >= end) continue;
            const text = (msg.message || "").trim();
            const hadAttachments = Boolean(msg.media);
            if (!includeEmpty && !text && !hadAttachments) continue;
            const isFromMe = Boolean(msg.out);
            let sender = "Unknown";
            if (isFromMe) {
              sender = myName;
            } else {
              try {
                const senderEntity = await msg.getSender();
                if (senderEntity && "firstName" in senderEntity) {
                  const e = senderEntity as { firstName?: string; lastName?: string; username?: string };
                  sender = [e.firstName, e.lastName].filter(Boolean).join(" ").trim() || e.username || sender;
                }
              } catch {
                /* ignore */
              }
            }
            messages.push({
              id: String(id),
              timestamp: ts,
              sender,
              text,
              isFromMe,
              hadAttachments,
            });
          }

          const conversationId = dialogIdStr;
          conversations.set(conversationId, {
            source: "telegram",
            conversationId,
            title: dialog.title || conversationId,
            participants: [],
            messages,
            chatId: dialogIdStr,
            service: "Telegram",
          });

          Object.assign(cursors, advanceCursor(cursors, dialogIdStr, observedIds));
        } catch (err) {
          if (isFloodWait(err)) {
            console.warn(
              `[telegram] Persistent FloodWait on dialog ${dialogIdStr}; saving partial progress and exiting cleanly.`,
            );
            bailedEarly = true;
            break;
          }
          throw err;
        }
      }
    } finally {
      try {
        saveCursors(cursors);
      } catch (err) {
        console.warn(`[telegram] Could not write cursors.json: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await client.disconnect();
      } catch {
        /* ignore */
      }
    }

    if (bailedEarly) {
      console.warn(`[telegram] Exited early due to FloodWait. Re-run later to resume.`);
    }
    return [...conversations.values()];
  },
};
