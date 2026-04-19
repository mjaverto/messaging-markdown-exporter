import { describe, expect, test } from "vitest";

import { sanitizeFilename } from "../src/utils.js";

describe("basic install-adjacent helpers", () => {
  test("keeps filenames reasonable", () => {
    expect(sanitizeFilename("Amazon OTP / Alerts")).toBe("Amazon OTP - Alerts");
  });
});
