import path from "node:path";

import { describe, expect, test } from "vitest";

import { telegramAdapter } from "../src/adapters/telegram.js";
import { whatsappAdapter } from "../src/adapters/whatsapp.js";

const fixtures = path.join(process.cwd(), "test", "fixtures");

describe("telegram adapter", () => {
  test("loads exported json with mixed text payloads", async () => {
    const file = path.join(fixtures, "telegram", "export.json");
    const conversations = await telegramAdapter.loadConversations({ exportPath: file });
    expect(conversations[0]?.title).toBe("Saved Messages");
    expect(conversations[0]?.messages[0]?.text).toBe("hello world");
    expect(conversations[0]?.messages[1]?.hadAttachments).toBe(true);
  });
});

describe("whatsapp adapter", () => {
  test("parses txt export and attachment marker", async () => {
    const file = path.join(fixtures, "whatsapp", "chat.txt");
    const conversations = await whatsappAdapter.loadConversations({ exportPath: file });
    expect(conversations[0]?.messages).toHaveLength(3);
    expect(conversations[0]?.messages[1]?.sender).toBe("Karissa");
    expect(conversations[0]?.messages[2]?.hadAttachments).toBe(true);
  });
});

