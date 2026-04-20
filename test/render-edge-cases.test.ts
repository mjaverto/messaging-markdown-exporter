/**
 * Additional render.ts coverage:
 *   - Signal group-chat with empty participants
 *   - No-contact fallback paths
 *   - renderLine edge cases (no text, attachments)
 *   - Error model classes
 */
import { describe, expect, test } from "vitest";

import { renderConversationDays } from "../src/core/render.js";
import {
  TransientAdapterError,
  PermanentAdapterError,
  EXIT_TRANSIENT,
  EXIT_PERMANENT,
  isAdapterSource,
  ADAPTER_SOURCES,
} from "../src/core/model.js";
import type { NormalizedConversation, NormalizedMessage } from "../src/core/model.js";

function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: "1",
    timestamp: new Date("2024-06-01T10:00:00Z"),
    sender: "Alice",
    text: "hello",
    isFromMe: false,
    hadAttachments: false,
    ...overrides,
  };
}

function makeConvo(overrides: Partial<NormalizedConversation> = {}): NormalizedConversation {
  return {
    source: "signal",
    conversationId: "c1",
    title: "Test Chat",
    participants: [],
    messages: [makeMsg()],
    ...overrides,
  };
}

describe("renderConversationDays — Signal group chat with empty participants", () => {
  test("renders without Participants line when participants array is empty", () => {
    const convo = makeConvo({
      source: "signal",
      participants: [],
      title: "Signal Group",
    });
    const files = renderConversationDays(convo);
    expect(files).toHaveLength(1);
    const content = files[0]!.content;
    // No "Participants:" header line since participants is empty
    expect(content).not.toContain("Participants:");
    // Source header is still present
    expect(content).toContain("Source: signal");
  });

  test("renders Participants header when participants are set", () => {
    const convo = makeConvo({
      source: "signal",
      participants: ["Alice", "Bob"],
      title: "Signal Group",
      messages: [makeMsg({ sender: "Alice" }), makeMsg({ id: "2", sender: "Bob" })],
    });
    const files = renderConversationDays(convo);
    expect(files[0]!.content).toContain("Participants: Alice, Bob");
  });
});

describe("renderConversationDays — no-text messages", () => {
  test("renders [no text] placeholder for empty text messages", () => {
    const convo = makeConvo({
      messages: [makeMsg({ text: "", hadAttachments: true })],
    });
    const files = renderConversationDays(convo);
    expect(files[0]!.content).toContain("[no text]");
    expect(files[0]!.content).toContain("[attachments omitted]");
  });

  test("renders attachment count when attachments array is present", () => {
    const convo = makeConvo({
      messages: [
        makeMsg({
          text: "check this",
          hadAttachments: true,
          attachments: [
            { name: "photo.jpg", kind: "image" },
            { name: "video.mp4", kind: "video" },
          ],
        }),
      ],
    });
    const files = renderConversationDays(convo);
    expect(files[0]!.content).toContain("2 attachments omitted");
  });

  test("renders singular attachment count", () => {
    const convo = makeConvo({
      messages: [
        makeMsg({
          text: "look",
          hadAttachments: true,
          attachments: [{ name: "photo.jpg", kind: "image" }],
        }),
      ],
    });
    const files = renderConversationDays(convo);
    expect(files[0]!.content).toContain("1 attachment omitted");
  });
});

describe("renderConversationDays — multi-participant without contacts", () => {
  test("resolvedTitle joins participants when no contact map", () => {
    const convo = makeConvo({
      title: "Group",
      participants: ["Alice", "Bob"],
      messages: [makeMsg()],
    });
    const files = renderConversationDays(convo);
    // title from conversation title (no contact map)
    expect(files[0]!.content).toContain("# Group");
  });

  test("resolvedTitle is conversation.title when no participants and no contacts", () => {
    const convo = makeConvo({
      title: "Saved Messages",
      participants: [],
      messages: [makeMsg()],
    });
    const files = renderConversationDays(convo);
    expect(files[0]!.content).toContain("# Saved Messages");
  });
});

describe("renderConversationDays — contact resolution", () => {
  test("resolves sender via contacts map for incoming messages using normalized handle", () => {
    // normalizeHandle("+15705551234") → "5705551234" (last 10 digits)
    const contacts = new Map([["5705551234", "Alice Resolved"]]);
    const convo = makeConvo({
      participants: ["+15705551234"],
      messages: [makeMsg({ sender: "+15705551234", isFromMe: false })],
    });
    const files = renderConversationDays(convo, { contacts });
    // sender should be resolved in the message line
    expect(files[0]!.content).toContain("Alice Resolved:");
  });

  test("resolvedTitle from participants when contacts provided", () => {
    const contacts = new Map([["alice-handle", "Alice Smith"]]);
    const convo = makeConvo({
      title: "alice-handle",
      participants: ["alice-handle"],
      messages: [makeMsg({ sender: "alice-handle", isFromMe: false })],
    });
    const files = renderConversationDays(convo, { contacts });
    expect(files[0]!.content).toContain("# Alice Smith");
  });
});

describe("Error model classes", () => {
  test("TransientAdapterError has correct name, source, exit code", () => {
    const err = new TransientAdapterError("DB locked", "imessage");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("TransientAdapterError");
    expect(err.source).toBe("imessage");
    expect(err.message).toBe("DB locked");
    expect(EXIT_TRANSIENT).toBe(75);
  });

  test("PermanentAdapterError has correct name, source, exit code", () => {
    const err = new PermanentAdapterError("Auth expired", "telegram");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PermanentAdapterError");
    expect(err.source).toBe("telegram");
    expect(err.message).toBe("Auth expired");
    expect(EXIT_PERMANENT).toBe(78);
  });

  test("isAdapterSource validates known and unknown sources", () => {
    for (const src of ADAPTER_SOURCES) {
      expect(isAdapterSource(src)).toBe(true);
    }
    expect(isAdapterSource("unknown")).toBe(false);
    expect(isAdapterSource("")).toBe(false);
  });
});

describe("renderConversationDays — multiple days", () => {
  test("messages on different days produce separate files", () => {
    const convo = makeConvo({
      messages: [
        makeMsg({ id: "1", timestamp: new Date("2024-06-01T10:00:00Z"), text: "day 1" }),
        makeMsg({ id: "2", timestamp: new Date("2024-06-02T10:00:00Z"), text: "day 2" }),
      ],
    });
    const files = renderConversationDays(convo);
    expect(files).toHaveLength(2);
    expect(files[0]!.relativePath).toContain("2024-06-01");
    expect(files[1]!.relativePath).toContain("2024-06-02");
  });

  test("frontmatter message_count reflects per-day count, not total", () => {
    const convo = makeConvo({
      messages: [
        makeMsg({ id: "1", timestamp: new Date("2024-06-01T10:00:00Z") }),
        makeMsg({ id: "2", timestamp: new Date("2024-06-01T11:00:00Z") }),
        makeMsg({ id: "3", timestamp: new Date("2024-06-02T10:00:00Z") }),
      ],
    });
    const files = renderConversationDays(convo);
    expect(files).toHaveLength(2);
    // Day 1 has 2 messages
    expect(files[0]!.content).toContain("message_count: 2");
    // Day 2 has 1 message
    expect(files[1]!.content).toContain("message_count: 1");
  });
});

describe("renderConversationDays — chatId formatting", () => {
  test("numeric chatId is rendered without quotes", () => {
    const convo = makeConvo({ chatId: 42, messages: [makeMsg()] });
    const files = renderConversationDays(convo);
    expect(files[0]!.content).toContain("chat_id: 42");
    expect(files[0]!.content).not.toContain('chat_id: "42"');
  });

  test("string chatId is rendered with quotes", () => {
    const convo = makeConvo({ chatId: "dialog-123", messages: [makeMsg()] });
    const files = renderConversationDays(convo);
    expect(files[0]!.content).toContain('chat_id: "dialog-123"');
  });

  test("null chatId is omitted from frontmatter", () => {
    const convo = makeConvo({ chatId: null, messages: [makeMsg()] });
    const files = renderConversationDays(convo);
    expect(files[0]!.content).not.toContain("chat_id:");
  });
});
