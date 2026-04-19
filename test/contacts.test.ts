import { describe, expect, test } from "vitest";

import { normalizeHandle } from "../src/contacts.js";

describe("normalizeHandle", () => {
  test("strips formatting from US phone numbers", () => {
    expect(normalizeHandle("+1 (570) 241-6510")).toBe("5702416510");
    expect(normalizeHandle("+15702416510")).toBe("5702416510");
    expect(normalizeHandle("570-241-6510")).toBe("5702416510");
    expect(normalizeHandle("570.241.6510")).toBe("5702416510");
  });

  test("lowercases and trims emails", () => {
    expect(normalizeHandle("  Mike@Example.COM  ")).toBe("mike@example.com");
  });

  test("handles empty input", () => {
    expect(normalizeHandle("")).toBe("");
  });
});
