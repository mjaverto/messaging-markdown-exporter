import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  loadTelegramConversations,
  readCursors,
  TelegramClientLike,
  TelegramDialogLike,
  TelegramMessageLike,
  withFloodWaitRetry,
} from "../src/adapters/telegram.js";
import { whatsappAdapter } from "../src/adapters/whatsapp.js";

const fixtures = path.join(process.cwd(), "test", "fixtures");

function makeClient(
  dialogs: TelegramDialogLike[],
  messagesByDialog: Record<string, TelegramMessageLike[]>,
): TelegramClientLike & { iterMessageCalls: { dialog: string; minId?: number }[] } {
  const iterMessageCalls: { dialog: string; minId?: number }[] = [];
  return {
    iterMessageCalls,
    async connect() {},
    async disconnect() {},
    async getMe() {
      return { id: 0 };
    },
    async *iterDialogs() {
      for (const dialog of dialogs) yield dialog;
    },
    async *iterMessages(dialog, options) {
      iterMessageCalls.push({ dialog: String(dialog.id), minId: options.minId });
      const batch = messagesByDialog[String(dialog.id)] || [];
      for (const message of batch) {
        if (options.minId !== undefined && message.id <= options.minId) continue;
        yield message;
      }
    },
  };
}

describe("telegram adapter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-adapter-"));
    fs.writeFileSync(
      path.join(tmpDir, "credentials.json"),
      JSON.stringify({ apiId: 1, apiHash: "abcdef0123456789" }),
    );
    fs.writeFileSync(path.join(tmpDir, "session.txt"), "fake-session");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("advances cursors past highest message id per dialog", async () => {
    fs.writeFileSync(path.join(tmpDir, "cursors.json"), JSON.stringify({ "100": "5" }));
    const dialogs: TelegramDialogLike[] = [
      { id: 100, title: "Friends" },
      { id: 200, title: "Work" },
    ];
    const messagesByDialog: Record<string, TelegramMessageLike[]> = {
      "100": [
        { id: 6, date: 1_700_000_000, message: "hello", out: false },
        { id: 9, date: 1_700_000_100, message: "world", out: true },
      ],
      "200": [{ id: 42, date: 1_700_000_200, message: "standup", out: false }],
    };
    const client = makeClient(dialogs, messagesByDialog);

    const conversations = await loadTelegramConversations(
      { telegramConfigDir: tmpDir },
      () => client,
    );

    expect(conversations).toHaveLength(2);
    expect(conversations[0]?.service).toBe("Telegram");
    expect(conversations[0]?.messages).toHaveLength(2);
    expect(conversations[0]?.messages[1]?.isFromMe).toBe(true);
    expect(client.iterMessageCalls[0]).toEqual({ dialog: "100", minId: 5 });
    expect(client.iterMessageCalls[1]).toEqual({ dialog: "200", minId: 0 });

    const cursors = readCursors(tmpDir);
    expect(cursors["100"]).toBe("9");
    expect(cursors["200"]).toBe("42");
  });

  test("skips dialogs with no new messages and leaves their cursor unchanged", async () => {
    fs.writeFileSync(path.join(tmpDir, "cursors.json"), JSON.stringify({ "100": "9" }));
    const client = makeClient([{ id: 100, title: "Friends" }], { "100": [] });

    const conversations = await loadTelegramConversations(
      { telegramConfigDir: tmpDir },
      () => client,
    );

    expect(conversations).toHaveLength(0);
    expect(readCursors(tmpDir)["100"]).toBe("9");
  });

  test("throws a guided error when credentials are missing", async () => {
    fs.rmSync(path.join(tmpDir, "credentials.json"));
    await expect(
      loadTelegramConversations({ telegramConfigDir: tmpDir }, () => makeClient([], {})),
    ).rejects.toThrow(/telegram-login/);
  });

  test("withFloodWaitRetry sleeps for err.seconds and retries once", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const result = await withFloodWaitRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          const err = Object.assign(new Error("FLOOD_WAIT_7"), {
            name: "FloodWaitError",
            errorMessage: "FLOOD_WAIT_7",
            seconds: 7,
          });
          throw err;
        }
        return "ok";
      },
      {
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([7000]);
  });

  test("withFloodWaitRetry rethrows non-FloodWait errors without sleeping", async () => {
    const sleeps: number[] = [];
    await expect(
      withFloodWaitRetry(
        async () => {
          throw new Error("network down");
        },
        {
          sleepFn: async (ms) => {
            sleeps.push(ms);
          },
        },
      ),
    ).rejects.toThrow("network down");
    expect(sleeps).toHaveLength(0);
  });
});

describe("whatsapp adapter", () => {
  test("reads native ChatStorage.sqlite fixture", async () => {
    const dbPath = path.join(fixtures, "whatsapp", "ChatStorage.sqlite");
    const conversations = await whatsappAdapter.loadConversations({
      whatsappDbPath: dbPath,
      myName: "Me",
      useContacts: false,
      start: new Date("2024-01-01T00:00:00Z"),
      end: new Date("2025-01-01T00:00:00Z"),
    });

    expect(conversations).toHaveLength(2);
    const oneToOne = conversations.find((c) => c.title === "Karissa");
    expect(oneToOne).toBeTruthy();
    expect(oneToOne?.service).toBe("WhatsApp");
    expect(oneToOne?.messages).toHaveLength(3);
    expect(oneToOne?.messages[0]?.sender).toBe("Karissa M");
    expect(oneToOne?.messages[0]?.text).toBe("hey there");
    expect(oneToOne?.messages[1]?.isFromMe).toBe(true);
    expect(oneToOne?.messages[1]?.sender).toBe("Me");
    expect(oneToOne?.messages[2]?.hadAttachments).toBe(true);
    expect(oneToOne?.messages[2]?.attachments?.[0]?.kind).toBe("image");

    const group = conversations.find((c) => c.title === "Family");
    expect(group?.messages[0]?.sender).toBe("Aunt Jane");
  });
});
