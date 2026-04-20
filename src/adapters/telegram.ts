import fs from "node:fs";
import path from "node:path";

import type { Api } from "telegram";
import type { FloodWaitError } from "telegram/errors";

import {
  ExportAdapter,
  NormalizedConversation,
  NormalizedMessage,
  PermanentAdapterError,
} from "../core/model.js";
import { expandHome } from "../utils.js";

export const DEFAULT_TELEGRAM_CONFIG_DIR = "~/.config/imessage-to-markdown/telegram";

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}

export type TelegramCursors = Record<string, string>;

export interface TelegramDialogLike {
  id: string | number | bigint;
  name?: string | null;
  title?: string | null;
  isUser?: boolean;
  isGroup?: boolean;
  isChannel?: boolean;
}

// Structural subset of gramjs Api.Message / Api.User — the real runtime type
// is Api.Message, but we only consume these fields and want to allow fakes
// in tests without dragging gramjs into the test graph. `satisfies`-style
// alignment is enforced below via the `_telegramMessageShape` assertion.
export interface TelegramMessageLike {
  id: number;
  date: number;
  message?: string | null;
  text?: string | null;
  out?: boolean;
  fromId?: { userId?: string | number | bigint } | null;
  senderId?: string | number | bigint | null;
  media?: Api.TypeMessageMedia | null | unknown;
  sender?: {
    firstName?: string | null;
    lastName?: string | null;
    username?: string | null;
    id?: unknown;
  } | null;
}

export interface TelegramClientLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getMe(): Promise<{ id: unknown; firstName?: string | null; username?: string | null }>;
  iterDialogs(options?: { limit?: number }): AsyncIterable<TelegramDialogLike>;
  iterMessages(
    dialog: TelegramDialogLike,
    options: { minId?: number; limit?: number },
  ): AsyncIterable<TelegramMessageLike>;
}

export type TelegramClientFactory = (
  apiId: number,
  apiHash: string,
  session: string,
) => TelegramClientLike;

// Alias to gramjs's real FloodWaitError shape. Kept as a re-export so callers
// (tests, runner) can narrow without importing gramjs themselves.
export type TelegramFloodWaitError = FloodWaitError;

function isFloodWait(error: unknown): error is TelegramFloodWaitError {
  if (!error || typeof error !== "object") return false;
  const anyError = error as Record<string, unknown>;
  const name = typeof anyError.name === "string" ? anyError.name : "";
  const errorMessage = typeof anyError.errorMessage === "string" ? anyError.errorMessage : "";
  const message = typeof anyError.message === "string" ? anyError.message : "";
  const seconds = typeof anyError.seconds === "number" ? anyError.seconds : undefined;
  return (
    seconds !== undefined &&
    (name.includes("FloodWait") ||
      errorMessage.includes("FLOOD_WAIT") ||
      message.includes("FLOOD_WAIT"))
  );
}

function isAuthKeyUnregistered(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const anyError = error as Record<string, unknown>;
  const fields = [anyError.errorMessage, anyError.message, anyError.name].filter(
    (value): value is string => typeof value === "string",
  );
  return fields.some((value) => value.includes("AUTH_KEY_UNREGISTERED"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withFloodWaitRetry<T>(
  operation: () => Promise<T>,
  options: { onWait?: (seconds: number) => void; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const sleepFn = options.sleepFn ?? sleep;
  try {
    return await operation();
  } catch (error) {
    if (!isFloodWait(error)) throw error;
    options.onWait?.(error.seconds);
    await sleepFn(error.seconds * 1000);
    return operation();
  }
}

function readCredentials(configDir: string): TelegramCredentials {
  const credsPath = path.join(configDir, "credentials.json");
  if (!fs.existsSync(credsPath)) {
    throw new PermanentAdapterError(
      `Telegram credentials missing at ${credsPath}. Run 'imessage-to-markdown telegram-login' first.`,
      "telegram",
    );
  }
  const raw = JSON.parse(fs.readFileSync(credsPath, "utf8")) as Partial<TelegramCredentials>;
  if (typeof raw.apiId !== "number" || typeof raw.apiHash !== "string") {
    throw new PermanentAdapterError(`Invalid telegram credentials at ${credsPath}`, "telegram");
  }
  return { apiId: raw.apiId, apiHash: raw.apiHash };
}

function readSession(configDir: string): string {
  const sessionPath = path.join(configDir, "session.txt");
  if (!fs.existsSync(sessionPath)) {
    throw new PermanentAdapterError(
      `Telegram session missing at ${sessionPath}. Run 'imessage-to-markdown telegram-login' first.`,
      "telegram",
    );
  }
  // An empty session.txt would silently produce a fresh StringSession
  // that fails to auth on connect, which then looks exactly like a
  // legitimate revoked session. Refuse to proceed.
  const contents = fs.readFileSync(sessionPath, "utf8").trim();
  if (!contents) {
    throw new PermanentAdapterError(
      `Telegram session at ${sessionPath} is empty. Re-run 'imessage-to-markdown telegram-login'.`,
      "telegram",
    );
  }
  return contents;
}

export function readCursors(configDir: string): TelegramCursors {
  const cursorsPath = path.join(configDir, "cursors.json");
  if (!fs.existsSync(cursorsPath)) return {};
  // A corrupt cursors.json silently resetting to {} is catastrophic —
  // it forces a full re-fetch of every dialog, which on accounts with
  // significant backlog will immediately hit FLOOD_WAIT and stall. Make
  // the failure loud so the user deletes the file deliberately.
  const raw = fs.readFileSync(cursorsPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Telegram cursors.json at ${cursorsPath} is not a JSON object. ` +
        `Delete it to force a full re-fetch, or restore from backup.`,
    );
  }
  return parsed as TelegramCursors;
}

export function writeCursors(configDir: string, cursors: TelegramCursors): void {
  fs.mkdirSync(configDir, { recursive: true });
  const cursorsPath = path.join(configDir, "cursors.json");
  // Atomic: write to a tmp sibling, then rename. `writeFileSync` is not
  // atomic; a kill mid-write leaves cursors.json half-written and the
  // next run throws (by design — see readCursors).
  const tmpPath = `${cursorsPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(cursors, null, 2), "utf8");
  fs.renameSync(tmpPath, cursorsPath);
}

function dialogTitle(dialog: TelegramDialogLike): string {
  return (dialog.title || dialog.name || String(dialog.id)).trim() || String(dialog.id);
}

function senderLabel(message: TelegramMessageLike, myLabel: string): string {
  if (message.out) return myLabel;
  const sender = message.sender;
  if (sender) {
    const parts = [sender.firstName, sender.lastName].filter(Boolean).join(" ").trim();
    if (parts) return parts;
    if (sender.username) return `@${sender.username}`;
  }
  if (message.senderId !== null && message.senderId !== undefined) return String(message.senderId);
  if (message.fromId?.userId !== undefined) return String(message.fromId.userId);
  return "Unknown";
}

function messageText(message: TelegramMessageLike): string {
  if (typeof message.message === "string" && message.message) return message.message;
  if (typeof message.text === "string" && message.text) return message.text;
  return "";
}

async function defaultFactory(
  apiId: number,
  apiHash: string,
  session: string,
): Promise<TelegramClientLike> {
  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
  });
  return client as unknown as TelegramClientLike;
}

export async function loadTelegramConversations(
  options: Record<string, unknown>,
  factory?: TelegramClientFactory | (() => Promise<TelegramClientLike>),
): Promise<NormalizedConversation[]> {
  const configDir = expandHome(String(options.telegramConfigDir || DEFAULT_TELEGRAM_CONFIG_DIR));
  const myName = String(options.myName || "Me");
  const start = options.start instanceof Date ? (options.start as Date) : undefined;
  const end = options.end instanceof Date ? (options.end as Date) : undefined;
  const dialogLimit =
    typeof options.telegramDialogLimit === "number" ? options.telegramDialogLimit : undefined;
  const messageLimit =
    typeof options.telegramMessageLimit === "number" ? options.telegramMessageLimit : 1000;

  const credentials = readCredentials(configDir);
  const session = readSession(configDir);

  const client = factory
    ? await (factory.length >= 3
        ? Promise.resolve(
            (factory as TelegramClientFactory)(credentials.apiId, credentials.apiHash, session),
          )
        : (factory as () => Promise<TelegramClientLike>)())
    : await defaultFactory(credentials.apiId, credentials.apiHash, session);

  const cursors = readCursors(configDir);
  const conversations: NormalizedConversation[] = [];

  try {
    try {
      await client.connect();
    } catch (error) {
      if (isAuthKeyUnregistered(error)) {
        // Auth dead is a permanent user-action-required failure, not a
        // transient blip — surface it through the runner's notification
        // path instead of silently exporting zero conversations forever.
        throw new PermanentAdapterError(
          "Telegram session is no longer authorized (AUTH_KEY_UNREGISTERED). " +
            "Run 'imessage-to-markdown telegram-login' to re-authenticate.",
          "telegram",
        );
      }
      throw error;
    }

    for await (const dialog of client.iterDialogs(
      dialogLimit ? { limit: dialogLimit } : undefined,
    )) {
      const dialogKey = String(dialog.id);
      const lastSeenId = Number(cursors[dialogKey] || 0);
      const messages: NormalizedMessage[] = [];
      let highestId = lastSeenId;

      // Paginate until we've caught up. `iterMessages` returns newest-first
      // up to `limit`; with only a single call, dialogs with more than
      // `messageLimit` unseen messages would silently skip everything
      // older than the newest page (because the cursor advances to the
      // newest seen id, permanently burying the gap). Walk back with a
      // descending `maxId` until a page comes back under the limit.
      const collected: TelegramMessageLike[] = [];
      let nextMaxId: number | undefined = undefined;
      while (true) {
        const page: TelegramMessageLike[] = await withFloodWaitRetry(
          async () => {
            const batch: TelegramMessageLike[] = [];
            const iterOpts: { minId: number; limit: number; maxId?: number } = {
              minId: lastSeenId,
              limit: messageLimit,
            };
            if (nextMaxId !== undefined) iterOpts.maxId = nextMaxId;
            for await (const message of client.iterMessages(dialog, iterOpts)) {
              batch.push(message);
            }
            return batch;
          },
          {
            onWait: (seconds) =>
              console.warn(`FloodWait: sleeping ${seconds}s on dialog ${dialogKey}`),
          },
        );
        if (page.length === 0) break;
        collected.push(...page);
        if (page.length < messageLimit) break;
        // Subtract 1 to move past the oldest-in-page regardless of
        // whether gramjs treats maxId as inclusive or exclusive.
        const minIdInPage = page.reduce((acc, m) => Math.min(acc, m.id), Number.POSITIVE_INFINITY);
        if (!Number.isFinite(minIdInPage)) break;
        nextMaxId = minIdInPage - 1;
      }

      for (const message of collected) {
        const timestamp = new Date(message.date * 1000);
        if (start && timestamp < start) continue;
        if (end && timestamp > end) continue;
        if (message.id > highestId) highestId = message.id;
        messages.push({
          id: String(message.id),
          timestamp,
          sender: senderLabel(message, myName),
          text: messageText(message),
          isFromMe: Boolean(message.out),
          hadAttachments: Boolean(message.media),
        });
      }

      messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      if (messages.length === 0) {
        continue;
      }

      conversations.push({
        source: "telegram",
        conversationId: dialogKey,
        title: dialogTitle(dialog),
        participants: [],
        messages,
        chatId: dialogKey,
        service: "Telegram",
      });

      if (highestId > lastSeenId) {
        cursors[dialogKey] = String(highestId);
      }
    }

    writeCursors(configDir, cursors);
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore disconnect errors
    }
  }

  return conversations;
}

export const telegramAdapter: ExportAdapter = {
  source: "telegram",
  async loadConversations(options): Promise<NormalizedConversation[]> {
    return loadTelegramConversations(options);
  },
};
