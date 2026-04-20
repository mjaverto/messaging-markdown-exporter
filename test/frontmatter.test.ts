import { describe, expect, test } from "vitest";

import { renderConversationDays, renderFrontmatter } from "../src/core/render.js";
import type { ChatFrontmatter, NormalizedConversation, NormalizedMessage } from "../src/core/model.js";

function makeMessage(overrides: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "1",
    timestamp: new Date("2026-04-19T08:30:00-04:00"),
    sender: "+15702416510",
    text: "hi",
    isFromMe: false,
    hadAttachments: false,
    ...overrides,
  };
}

function makeConversation(overrides: Partial<NormalizedConversation>): NormalizedConversation {
  return {
    source: "imessage",
    conversationId: "chat-1",
    title: "+15702416510",
    participants: ["+15702416510"],
    messages: [makeMessage({})],
    chatId: 42,
    service: "iMessage",
    ...overrides,
  };
}

describe("renderConversationDays — 1:1 chat with contacts", () => {
  test("frontmatter uses contact field, not participants", () => {
    const contacts = new Map<string, string>([["5702416510", "Karissa Smith"]]);
    const conversation = makeConversation({});
    const files = renderConversationDays(conversation, {
      contacts,
      exportedAt: new Date("2026-04-19T19:30:00Z"),
    });

    expect(files).toHaveLength(1);
    const content = files[0]!.content;
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('contact: "Karissa Smith"');
    expect(content).not.toContain("participants:");
    expect(content).toContain('handles: ["+15702416510"]');
    expect(content).toContain("chat_id: 42");
    expect(content).toContain('service: "iMessage"');
    expect(content).toContain("message_count: 1");
    expect(content).toContain("first_message: 2026-04-19T12:30:00.000Z");
    expect(content).toContain("last_message: 2026-04-19T12:30:00.000Z");
    expect(content).toContain("exported_at: 2026-04-19T19:30:00.000Z");
    expect(content).toContain("# Karissa Smith");
  });

  test("falls back to raw handle when no contact match", () => {
    const conversation = makeConversation({});
    const files = renderConversationDays(conversation, {
      contacts: new Map(),
      exportedAt: new Date("2026-04-19T19:30:00Z"),
    });
    const content = files[0]!.content;
    expect(content).toContain('contact: "+15702416510"');
  });
});

describe("renderConversationDays — group chat", () => {
  test("frontmatter uses participants, not contact", () => {
    const contacts = new Map<string, string>([
      ["5702416510", "Karissa Smith"],
      ["mike@example.com", "Mike Averto"],
    ]);
    const conversation = makeConversation({
      participants: ["+15702416510", "mike@example.com"],
      messages: [
        makeMessage({ sender: "+15702416510", text: "first" }),
        makeMessage({
          id: "2",
          sender: "mike@example.com",
          text: "second",
          timestamp: new Date("2026-04-19T08:31:00-04:00"),
        }),
      ],
    });
    const files = renderConversationDays(conversation, {
      contacts,
      exportedAt: new Date("2026-04-19T19:30:00Z"),
    });
    const content = files[0]!.content;
    expect(content).not.toContain("contact:");
    expect(content).toContain('participants: ["Karissa Smith", "Mike Averto"]');
    expect(content).toContain('handles: ["+15702416510", "mike@example.com"]');
    expect(content).toContain("message_count: 2");
  });
});

describe("renderConversationDays — useContactNames", () => {
  test("uses resolved name as filename for 1:1 when enabled", () => {
    const contacts = new Map<string, string>([["5702416510", "Karissa Smith"]]);
    const files = renderConversationDays(makeConversation({}), {
      contacts,
      useContactNames: true,
    });
    expect(files[0]!.relativePath).toContain("Karissa Smith.md");
  });

  test("keeps slug-based filename for groups even with useContactNames", () => {
    const contacts = new Map<string, string>([["5702416510", "Karissa Smith"]]);
    const conv = makeConversation({
      participants: ["+15702416510", "+15558675309"],
      title: "Group Chat",
    });
    const files = renderConversationDays(conv, { contacts, useContactNames: true });
    expect(files[0]!.relativePath).toContain("Group Chat.md");
  });
});

describe("renderConversationDays — contacts_resolved marker", () => {
  test("emits contacts_resolved: false when contacts map was attempted but empty", () => {
    const files = renderConversationDays(makeConversation({}), {
      contacts: new Map(),
      exportedAt: new Date("2026-04-19T19:30:00Z"),
    });
    expect(files[0]!.content).toContain("contacts_resolved: false");
  });

  test("omits contacts_resolved when contacts resolved to a non-empty map", () => {
    const contacts = new Map<string, string>([["5702416510", "Karissa Smith"]]);
    const files = renderConversationDays(makeConversation({}), {
      contacts,
      exportedAt: new Date("2026-04-19T19:30:00Z"),
    });
    expect(files[0]!.content).not.toContain("contacts_resolved");
  });

  test("omits contacts_resolved when contacts resolution was opted out (undefined)", () => {
    const files = renderConversationDays(makeConversation({}), {
      exportedAt: new Date("2026-04-19T19:30:00Z"),
    });
    expect(files[0]!.content).not.toContain("contacts_resolved");
  });
});

describe("renderFrontmatter", () => {
  test("escapes quotes in contact names", () => {
    const fm: ChatFrontmatter = {
      contact: 'Karissa "K" Smith',
      handles: ["+15702416510"],
      chatId: 1,
      service: "iMessage",
      source: "imessage",
      messageCount: 1,
      firstMessage: "2026-04-19T12:30:00.000Z",
      lastMessage: "2026-04-19T12:30:00.000Z",
      exportedAt: "2026-04-19T19:30:00.000Z",
    };
    expect(renderFrontmatter(fm)).toContain('contact: "Karissa \\"K\\" Smith"');
  });
});
