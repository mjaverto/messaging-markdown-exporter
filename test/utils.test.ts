import { describe, expect, test } from "vitest";

import { looksLikeSystemChat, sanitizeFilename } from "../src/utils.js";

describe("sanitizeFilename", () => {
  test("strips bad chars", () => {
    expect(sanitizeFilename(" Karissa / Family: 💬 ")).toBe("Karissa - Family");
  });

  test("falls back when empty", () => {
    expect(sanitizeFilename("***", "chat")).toBe("chat");
  });
});

describe("looksLikeSystemChat", () => {
  test("detects obvious verification chats", () => {
    expect(looksLikeSystemChat("Verification Code", [])).toBe(true);
    expect(looksLikeSystemChat("Karissa", ["+15555551212"])).toBe(false);
  });
});
