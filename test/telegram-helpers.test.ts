import { describe, expect, test } from "vitest";

import { advanceCursor, withFloodWaitRetry } from "../src/adapters/telegram.js";

describe("advanceCursor", () => {
  test("returns input cursors when no observed ids", () => {
    expect(advanceCursor({ a: 5 }, "a", [])).toEqual({ a: 5 });
  });

  test("advances to max observed id", () => {
    expect(advanceCursor({}, "a", [3, 7, 1])).toEqual({ a: 7 });
  });

  test("never regresses below existing cursor", () => {
    expect(advanceCursor({ a: 100 }, "a", [3, 7, 1])).toEqual({ a: 100 });
  });

  test("preserves other dialog cursors", () => {
    expect(advanceCursor({ a: 1, b: 99 }, "a", [50])).toEqual({ a: 50, b: 99 });
  });
});

describe("withFloodWaitRetry", () => {
  test("returns value when fn succeeds first try", async () => {
    let calls = 0;
    const result = await withFloodWaitRetry(async () => {
      calls += 1;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("re-throws non-flood errors immediately", async () => {
    let calls = 0;
    await expect(
      withFloodWaitRetry(async () => {
        calls += 1;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  test("retries once on FloodWait-shaped error then succeeds", async () => {
    let calls = 0;
    const result = await withFloodWaitRetry<string>(async () => {
      calls += 1;
      if (calls === 1) {
        const err = Object.assign(new Error("FLOOD_WAIT"), {
          seconds: 0, // 0s -> immediate retry, no test wait
          errorMessage: "FLOOD_WAIT",
          className: "FloodWaitError",
        });
        throw err;
      }
      return "recovered";
    });
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  test("propagates the error from the second call if it also throws", async () => {
    let calls = 0;
    await expect(
      withFloodWaitRetry(async () => {
        calls += 1;
        const err = Object.assign(new Error("FLOOD_WAIT"), {
          seconds: 0,
          errorMessage: "FLOOD_WAIT",
          className: "FloodWaitError",
        });
        throw err;
      }),
    ).rejects.toThrow("FLOOD_WAIT");
    expect(calls).toBe(2);
  });
});
