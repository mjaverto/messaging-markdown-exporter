/**
 * Tests for telegram adapter error paths and cursor management:
 *   - PermanentAdapterError on AUTH_KEY_UNREGISTERED
 *   - readCursors with corrupt JSON throws
 *   - writeCursors atomically writes and reads back correctly
 *   - dialogTitle / senderLabel branches
 *   - Empty session file throws PermanentAdapterError
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  loadTelegramConversations,
  readCursors,
  writeCursors,
  TelegramClientLike,
  TelegramDialogLike,
  TelegramMessageLike,
} from "../src/adapters/telegram.js";
import { PermanentAdapterError } from "../src/core/model.js";

function makeClient(
  dialogs: TelegramDialogLike[],
  messagesByDialog: Record<string, TelegramMessageLike[]>,
  connectError?: Error,
): TelegramClientLike {
  return {
    async connect() {
      if (connectError) throw connectError;
    },
    async disconnect() {},
    async getMe() {
      return { id: 0 };
    },
    async *iterDialogs() {
      for (const dialog of dialogs) yield dialog;
    },
    async *iterMessages(dialog, options) {
      const batch = messagesByDialog[String(dialog.id)] || [];
      for (const msg of batch) {
        if (options.minId !== undefined && msg.id <= options.minId) continue;
        yield msg;
      }
    },
  };
}

describe("telegram adapter — error paths", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-err-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "credentials.json"),
      JSON.stringify({ apiId: 1, apiHash: "abc123" }),
    );
    fs.writeFileSync(path.join(tmpDir, "session.txt"), "fake-session");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("throws PermanentAdapterError when session file is empty", async () => {
    fs.writeFileSync(path.join(tmpDir, "session.txt"), "  "); // whitespace only
    await expect(
      loadTelegramConversations({ telegramConfigDir: tmpDir }, () => makeClient([], {})),
    ).rejects.toThrow(PermanentAdapterError);
  });

  test("throws PermanentAdapterError when session file is missing", async () => {
    fs.rmSync(path.join(tmpDir, "session.txt"));
    await expect(
      loadTelegramConversations({ telegramConfigDir: tmpDir }, () => makeClient([], {})),
    ).rejects.toThrow(/telegram-login/i);
  });

  test("re-throws PermanentAdapterError on AUTH_KEY_UNREGISTERED during connect", async () => {
    const authErr = Object.assign(new Error("AUTH_KEY_UNREGISTERED"), {
      errorMessage: "AUTH_KEY_UNREGISTERED",
    });
    await expect(
      loadTelegramConversations({ telegramConfigDir: tmpDir }, () => makeClient([], {}, authErr)),
    ).rejects.toThrow(PermanentAdapterError);
  });

  test("re-throws unknown connect errors as-is", async () => {
    const unknownErr = new Error("some network error");
    await expect(
      loadTelegramConversations({ telegramConfigDir: tmpDir }, () =>
        makeClient([], {}, unknownErr),
      ),
    ).rejects.toThrow("some network error");
  });

  test("readCursors returns empty object when file missing", () => {
    const cursors = readCursors(tmpDir);
    expect(cursors).toEqual({});
  });

  test("readCursors throws on corrupt JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "cursors.json"), "not valid json");
    expect(() => readCursors(tmpDir)).toThrow();
  });

  test("readCursors throws when cursors.json is an array instead of object", () => {
    fs.writeFileSync(path.join(tmpDir, "cursors.json"), JSON.stringify([1, 2, 3]));
    expect(() => readCursors(tmpDir)).toThrow(/not a JSON object/);
  });

  test("writeCursors creates file atomically and reads back", () => {
    writeCursors(tmpDir, { "100": "42", "200": "99" });
    const read = readCursors(tmpDir);
    expect(read["100"]).toBe("42");
    expect(read["200"]).toBe("99");
  });

  test("date filtering: messages outside start/end are excluded", async () => {
    const start = new Date("2024-01-01T00:00:00Z");
    const end = new Date("2024-12-31T00:00:00Z");

    const dialogs: TelegramDialogLike[] = [{ id: 1, title: "Chat" }];
    const messages: TelegramMessageLike[] = [
      {
        id: 1,
        date: Math.floor(new Date("2023-06-01T00:00:00Z").getTime() / 1000),
        message: "too old",
        out: false,
      },
      {
        id: 2,
        date: Math.floor(new Date("2024-06-01T00:00:00Z").getTime() / 1000),
        message: "in range",
        out: false,
      },
      {
        id: 3,
        date: Math.floor(new Date("2025-06-01T00:00:00Z").getTime() / 1000),
        message: "too new",
        out: false,
      },
    ];

    const conversations = await loadTelegramConversations(
      { telegramConfigDir: tmpDir, start, end },
      () => makeClient(dialogs, { "1": messages }),
    );

    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.messages).toHaveLength(1);
    expect(conversations[0]!.messages[0]!.text).toBe("in range");
  });

  test("senderLabel uses firstName+lastName from sender", async () => {
    const dialogs: TelegramDialogLike[] = [{ id: 1, title: "Chat" }];
    const messages: TelegramMessageLike[] = [
      {
        id: 1,
        date: Math.floor(new Date("2024-06-01T00:00:00Z").getTime() / 1000),
        message: "hi",
        out: false,
        sender: { firstName: "John", lastName: "Doe", username: "johndoe" },
      },
    ];

    const conversations = await loadTelegramConversations({ telegramConfigDir: tmpDir }, () =>
      makeClient(dialogs, { "1": messages }),
    );
    expect(conversations[0]!.messages[0]!.sender).toBe("John Doe");
  });

  test("senderLabel falls back to @username when no name", async () => {
    const dialogs: TelegramDialogLike[] = [{ id: 1, title: "Chat" }];
    const messages: TelegramMessageLike[] = [
      {
        id: 1,
        date: Math.floor(new Date("2024-06-01T00:00:00Z").getTime() / 1000),
        message: "hi",
        out: false,
        sender: { firstName: null, lastName: null, username: "johndoe" },
      },
    ];

    const conversations = await loadTelegramConversations({ telegramConfigDir: tmpDir }, () =>
      makeClient(dialogs, { "1": messages }),
    );
    expect(conversations[0]!.messages[0]!.sender).toBe("@johndoe");
  });

  test("senderLabel falls back to senderId when sender is null", async () => {
    const dialogs: TelegramDialogLike[] = [{ id: 1, title: "Chat" }];
    const messages: TelegramMessageLike[] = [
      {
        id: 1,
        date: Math.floor(new Date("2024-06-01T00:00:00Z").getTime() / 1000),
        message: "hi",
        out: false,
        sender: null,
        senderId: 9999,
      },
    ];

    const conversations = await loadTelegramConversations({ telegramConfigDir: tmpDir }, () =>
      makeClient(dialogs, { "1": messages }),
    );
    expect(conversations[0]!.messages[0]!.sender).toBe("9999");
  });

  test("invalid credentials JSON throws on parse", async () => {
    fs.writeFileSync(path.join(tmpDir, "credentials.json"), "invalid json");
    await expect(
      loadTelegramConversations({ telegramConfigDir: tmpDir }, () => makeClient([], {})),
    ).rejects.toThrow();
  });

  test("credentials with wrong apiId type throws PermanentAdapterError", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "credentials.json"),
      JSON.stringify({ apiId: "not-a-number", apiHash: "abc" }),
    );
    await expect(
      loadTelegramConversations({ telegramConfigDir: tmpDir }, () => makeClient([], {})),
    ).rejects.toThrow(PermanentAdapterError);
  });

  test("dialogTitle uses name when title missing", async () => {
    const dialogs: TelegramDialogLike[] = [{ id: 42, name: "My Dialog", title: undefined }];
    const messages: TelegramMessageLike[] = [
      {
        id: 1,
        date: Math.floor(new Date("2024-06-01T00:00:00Z").getTime() / 1000),
        message: "hello",
      },
    ];

    const conversations = await loadTelegramConversations({ telegramConfigDir: tmpDir }, () =>
      makeClient(dialogs, { "42": messages }),
    );
    expect(conversations[0]!.title).toBe("My Dialog");
  });

  test("messageText falls back to text property when message is empty", async () => {
    const dialogs: TelegramDialogLike[] = [{ id: 1, title: "Chat" }];
    const messages: TelegramMessageLike[] = [
      {
        id: 1,
        date: Math.floor(new Date("2024-06-01T00:00:00Z").getTime() / 1000),
        message: "",
        text: "fallback text",
        out: true,
      },
    ];

    const conversations = await loadTelegramConversations({ telegramConfigDir: tmpDir }, () =>
      makeClient(dialogs, { "1": messages }),
    );
    expect(conversations[0]!.messages[0]!.text).toBe("fallback text");
  });
});
