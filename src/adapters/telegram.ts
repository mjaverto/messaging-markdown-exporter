import fs from "node:fs";
import path from "node:path";

import { ExportAdapter, NormalizedConversation, NormalizedMessage } from "../core/model.js";
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

export interface TelegramMessageLike {
  id: number;
  date: number;
  message?: string | null;
  text?: string | null;
  out?: boolean;
  fromId?: { userId?: string | number | bigint } | null;
  senderId?: string | number | bigint | null;
  media?: unknown;
  sender?: { firstName?: string | null; lastName?: string | null; username?: string | null; id?: unknown } | null;
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

export interface TelegramClientFactory {
  (apiId: number, apiHash: string, session: string): TelegramClientLike;
}

export interface TelegramFloodWaitError extends Error {
  seconds: number;
}

function isFloodWait(error: unknown): error is TelegramFloodWaitError {
  if (!error || typeof error !== "object") return false;
  const anyError = error as Record<string, unknown>;
  const name = typeof anyError.name === "string" ? anyError.name : "";
  const errorMessage = typeof anyError.errorMessage === "string" ? anyError.errorMessage : "";
  const message = typeof anyError.message === "string" ? anyError.message : "";
  const seconds = typeof anyError.seconds === "number" ? anyError.seconds : undefined;
  return (
    seconds !== undefined &&
    (name.includes("FloodWait") || errorMessage.includes("FLOOD_WAIT") || message.includes("FLOOD_WAIT"))
  );
}

function isAuthKeyUnregistered(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const anyError = error as Record<string, unknown>;
  const fields = [anyError.errorMessage, anyError.message, anyError.name]
    .filter((value): value is string => typeof value === "string");
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
    throw new Error(
      `Telegram credentials missing at ${credsPath}. Run 'imessage-to-markdown telegram-login' first.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(credsPath, "utf8")) as Partial<TelegramCredentials>;
  if (typeof raw.apiId !== "number" || typeof raw.apiHash !== "string") {
    throw new Error(`Invalid telegram credentials at ${credsPath}`);
  }
  return { apiId: raw.apiId, apiHash: raw.apiHash };
}

function readSession(configDir: string): string {
  const sessionPath = path.join(configDir, "session.txt");
  if (!fs.existsSync(sessionPath)) {
    throw new Error(
      `Telegram session missing at ${sessionPath}. Run 'imessage-to-markdown telegram-login' first.`,
    );
  }
  return fs.readFileSync(sessionPath, "utf8").trim();
}

export function readCursors(configDir: string): TelegramCursors {
  const cursorsPath = path.join(configDir, "cursors.json");
  if (!fs.existsSync(cursorsPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
    if (parsed && typeof parsed === "object") return parsed as TelegramCursors;
  } catch {
    // fall through
  }
  return {};
}

export function writeCursors(configDir: string, cursors: TelegramCursors): void {
  fs.mkdirSync(configDir, { recursive: true });
  const cursorsPath = path.join(configDir, "cursors.json");
  fs.writeFileSync(cursorsPath, JSON.stringify(cursors, null, 2), "utf8");
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

async function defaultFactory(apiId: number, apiHash: string, session: string): Promise<TelegramClientLike> {
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
  const configDir = expandHome(
    String(options.telegramConfigDir || DEFAULT_TELEGRAM_CONFIG_DIR),
  );
  const myName = String(options.myName || "Me");
  const start = options.start instanceof Date ? (options.start as Date) : undefined;
  const end = options.end instanceof Date ? (options.end as Date) : undefined;
  const dialogLimit = typeof options.telegramDialogLimit === "number" ? options.telegramDialogLimit : undefined;
  const messageLimit = typeof options.telegramMessageLimit === "number" ? options.telegramMessageLimit : 1000;

  const credentials = readCredentials(configDir);
  const session = readSession(configDir);

  const client = factory
    ? await (factory.length >= 3
        ? Promise.resolve((factory as TelegramClientFactory)(credentials.apiId, credentials.apiHash, session))
        : (factory as () => Promise<TelegramClientLike>)())
    : await defaultFactory(credentials.apiId, credentials.apiHash, session);

  const cursors = readCursors(configDir);
  const conversations: NormalizedConversation[] = [];

  try {
    try {
      await client.connect();
    } catch (error) {
      if (isAuthKeyUnregistered(error)) {
        console.warn(
          "\n⚠️  Telegram session is no longer authorized (AUTH_KEY_UNREGISTERED).\n" +
            "Run 'imessage-to-markdown telegram-login' to re-authenticate. Exiting without looping.\n",
        );
        return [];
      }
      throw error;
    }

    for await (const dialog of client.iterDialogs(dialogLimit ? { limit: dialogLimit } : undefined)) {
      const dialogKey = String(dialog.id);
      const lastSeenId = Number(cursors[dialogKey] || 0);
      const messages: NormalizedMessage[] = [];
      let highestId = lastSeenId;

      const collected = await withFloodWaitRetry(
        async () => {
          const batch: TelegramMessageLike[] = [];
          for await (const message of client.iterMessages(dialog, {
            minId: lastSeenId,
            limit: messageLimit,
          })) {
            batch.push(message);
          }
          return batch;
        },
        { onWait: (seconds) => console.warn(`FloodWait: sleeping ${seconds}s on dialog ${dialogKey}`) },
      );

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
