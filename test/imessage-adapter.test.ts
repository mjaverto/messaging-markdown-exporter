/**
 * Unit tests for the iMessage adapter.
 *
 * Uses the synthetic fixture at test/fixtures/imessage.chat.db (plain SQLite,
 * no encryption). The adapter shells out to the `sqlite3` CLI so this requires
 * sqlite3 to be on PATH (standard on macOS).
 */
import { describe, expect, test } from "vitest";
import path from "node:path";

import { iMessageAdapter } from "../src/adapters/imessage.js";

const FIXTURES = path.join(process.cwd(), "test", "fixtures");
const IMESSAGE_DB = path.join(FIXTURES, "imessage.chat.db");

describe("iMessageAdapter — fixture-based", () => {
  test("loads 1:1 conversation from fixture", async () => {
    const conversations = await iMessageAdapter.loadConversations({
      dbPath: IMESSAGE_DB,
      myName: "Me",
      start: new Date("2024-01-01T00:00:00Z"),
      end: new Date("2025-01-01T00:00:00Z"),
      includeEmpty: false,
    });

    expect(conversations.length).toBeGreaterThanOrEqual(1);
    const oneToOne = conversations.find(
      (c) =>
        c.conversationId === "iMessage;-;+15705551234" || c.participants.includes("+15705551234"),
    );
    expect(oneToOne).toBeDefined();
    expect(oneToOne?.source).toBe("imessage");
    expect(oneToOne?.messages.length).toBeGreaterThanOrEqual(1);
  });

  test("loads group conversation from fixture", async () => {
    const conversations = await iMessageAdapter.loadConversations({
      dbPath: IMESSAGE_DB,
      myName: "Me",
      start: new Date("2024-01-01T00:00:00Z"),
      end: new Date("2025-01-01T00:00:00Z"),
      includeEmpty: false,
    });

    const group = conversations.find((c) => c.title === "Family Group");
    expect(group).toBeDefined();
    expect(group?.source).toBe("imessage");
  });

  test("respects date range — excludes messages outside window", async () => {
    const conversations = await iMessageAdapter.loadConversations({
      dbPath: IMESSAGE_DB,
      myName: "Me",
      start: new Date("2020-01-01T00:00:00Z"),
      end: new Date("2021-01-01T00:00:00Z"),
      includeEmpty: false,
    });
    expect(conversations).toHaveLength(0);
  });

  test("distinguishes is_from_me messages", async () => {
    const conversations = await iMessageAdapter.loadConversations({
      dbPath: IMESSAGE_DB,
      myName: "Me",
      start: new Date("2024-01-01T00:00:00Z"),
      end: new Date("2025-01-01T00:00:00Z"),
      includeEmpty: false,
    });

    // Find conversation with both directions
    const conv = conversations.find(
      (c) => c.messages.some((m) => m.isFromMe) && c.messages.some((m) => !m.isFromMe),
    );
    expect(conv).toBeDefined();
    const fromMe = conv!.messages.find((m) => m.isFromMe);
    const notFromMe = conv!.messages.find((m) => !m.isFromMe);
    expect(fromMe?.sender).toBe("Me");
    expect(notFromMe?.sender).toBe("+15705551234");
  });

  test("attachment is detected on message 1", async () => {
    const conversations = await iMessageAdapter.loadConversations({
      dbPath: IMESSAGE_DB,
      myName: "Me",
      start: new Date("2024-01-01T00:00:00Z"),
      end: new Date("2025-01-01T00:00:00Z"),
      includeEmpty: false,
    });

    // Message 1 has an image attachment
    const allMessages = conversations.flatMap((c) => c.messages);
    const withAttachment = allMessages.find((m) => m.hadAttachments);
    expect(withAttachment).toBeDefined();
    expect(withAttachment?.attachments?.[0]?.kind).toBe("image");
  });

  test("throws when dbPath does not exist", async () => {
    await expect(
      iMessageAdapter.loadConversations({
        dbPath: "/nonexistent/path/chat.db",
        myName: "Me",
        start: new Date("2024-01-01T00:00:00Z"),
        end: new Date("2025-01-01T00:00:00Z"),
      }),
    ).rejects.toThrow();
  });
});
