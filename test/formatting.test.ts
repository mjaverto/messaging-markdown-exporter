import { describe, expect, test } from "vitest";

import { groupMessagesByChatDay, renderMarkdown, renderMessageLine } from "../src/formatting.js";
import type { ExportMessage } from "../src/types.js";

function makeMessage(id: number, iso: string, text: string): ExportMessage {
  return {
    messageId: id,
    timestamp: new Date(iso),
    sender: id % 2 ? "Mike" : "Karissa",
    text,
    isFromMe: Boolean(id % 2),
    hadAttachments: id === 3,
    chatDisplayName: "Karissa",
    participants: ["Karissa"],
  };
}

describe("renderMessageLine", () => {
  test("adds attachment note", () => {
    expect(renderMessageLine(makeMessage(3, "2026-04-19T08:30:00-04:00", "Photo incoming"))).toContain("[attachments omitted]");
  });
});

describe("groupMessagesByChatDay", () => {
  test("splits by date", () => {
    const groups = groupMessagesByChatDay([
      makeMessage(1, "2026-04-19T08:30:00-04:00", "hey"),
      makeMessage(2, "2026-04-20T09:30:00-04:00", "yo"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.dateKey).toBe("2026-04-19");
    expect(groups[1]?.dateKey).toBe("2026-04-20");
  });

  test("renders markdown", () => {
    const group = groupMessagesByChatDay([makeMessage(1, "2026-04-19T08:30:00-04:00", "hello there")])[0];
    expect(renderMarkdown(group!)).toContain("# Karissa");
    expect(renderMarkdown(group!)).toContain("Mike: hello there");
  });
});
