import { describe, expect, test } from "vitest";

import { renderConversationDays } from "../src/core/render.js";
import type { NormalizedConversation, NormalizedMessage } from "../src/core/model.js";

function makeMessage(id: number, iso: string, text: string): NormalizedMessage {
  return {
    id: String(id),
    timestamp: new Date(iso),
    sender: id % 2 ? "Mike" : "Karissa",
    text,
    isFromMe: Boolean(id % 2),
    hadAttachments: id === 3,
  };
}

function makeConversation(messages: NormalizedMessage[]): NormalizedConversation {
  return {
    source: "imessage",
    conversationId: "karissa-thread",
    title: "Karissa",
    participants: ["Karissa"],
    messages,
  };
}

describe("renderConversationDays", () => {
  test("splits by date", () => {
    const files = renderConversationDays(
      makeConversation([
        makeMessage(1, "2026-04-19T08:30:00-04:00", "hey"),
        makeMessage(2, "2026-04-20T09:30:00-04:00", "yo"),
      ]),
    );
    expect(files).toHaveLength(2);
    expect(files[0]?.relativePath).toContain("2026-04-19");
    expect(files[1]?.relativePath).toContain("2026-04-20");
  });

  test("renders participant and attachment info", () => {
    const files = renderConversationDays(
      makeConversation([makeMessage(3, "2026-04-19T08:30:00-04:00", "hello there")]),
    );
    const content = files[0]?.content || "";
    expect(content).toContain("# Karissa");
    expect(content).toContain("Participants: Karissa");
    expect(content).toContain("attachments omitted");
  });

  test.each(["imessage", "telegram", "whatsapp", "signal"] as const)(
    "writes flat <date>/<file>.md for %s (no source-name prefix)",
    (source) => {
      const conversation: NormalizedConversation = {
        source,
        conversationId: "c1",
        title: "Karissa",
        participants: ["Karissa"],
        messages: [makeMessage(1, "2026-04-19T08:30:00-04:00", "hi")],
      };
      const files = renderConversationDays(conversation);
      expect(files).toHaveLength(1);
      expect(files[0]?.relativePath).toMatch(/^2026-04-19\/[^/]+\.md$/);
      expect(files[0]?.relativePath.startsWith(`${source}/`)).toBe(false);
    },
  );
});
