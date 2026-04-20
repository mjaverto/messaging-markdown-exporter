/**
 * Unit tests for the Signal adapter.
 *
 * Uses the synthetic fixture at test/fixtures/signal.db (encrypted with
 * SQLCipher using the all-zeros test key) and test/fixtures/signal-config.json
 * (uses the legacy "key" field so no macOS Keychain is needed).
 */
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { signalAdapter, SignalDatabaseBusyError } from "../src/adapters/signal.js";
import { TransientAdapterError } from "../src/core/model.js";

const FIXTURES = path.join(process.cwd(), "test", "fixtures");
const SIGNAL_DB = path.join(FIXTURES, "signal.db");
const SIGNAL_CONFIG = path.join(FIXTURES, "signal-config.json");

describe("signalAdapter — fixture-based", () => {
  test("loads conversations from fixture DB", async () => {
    const conversations = await signalAdapter.loadConversations({
      signalDbPath: SIGNAL_DB,
      signalConfigPath: SIGNAL_CONFIG,
      start: new Date("2024-01-01T00:00:00Z"),
      end: new Date("2025-01-01T00:00:00Z"),
      myName: "Me",
      includeEmpty: false,
    });

    // conv-1 (Alice) has msg-1 and msg-2 which are incoming/outgoing — both in range
    // conv-2 (Work Group) has msg-3 which is incoming — in range
    // msg-4 is call-history type, filtered out by the WHERE clause
    expect(conversations.length).toBeGreaterThanOrEqual(1);

    const alice = conversations.find((c) => c.conversationId === "conv-1");
    expect(alice).toBeDefined();
    expect(alice?.title).toBe("Alice");
    expect(alice?.service).toBe("Signal");
    expect(alice?.source).toBe("signal");
    // msg-4 (call-history) should be excluded
    expect(alice?.messages.every((m) => m.text !== "call started")).toBe(true);
    // Verify both incoming and outgoing messages are loaded
    const incoming = alice?.messages.find((m) => !m.isFromMe);
    const outgoing = alice?.messages.find((m) => m.isFromMe);
    expect(incoming?.text).toBe("hey there");
    expect(outgoing?.text).toBe("hello back");
    expect(outgoing?.sender).toBe("Me");
  });

  test("date range filtering excludes messages outside window", async () => {
    // Only load messages before the fixture dates
    const conversations = await signalAdapter.loadConversations({
      signalDbPath: SIGNAL_DB,
      signalConfigPath: SIGNAL_CONFIG,
      start: new Date("2020-01-01T00:00:00Z"),
      end: new Date("2021-01-01T00:00:00Z"),
      myName: "Me",
      includeEmpty: false,
    });
    // No messages fall in 2020-2021
    expect(conversations).toHaveLength(0);
  });

  test("includeEmpty=false drops conversations with no messages after filter", async () => {
    const allConversations = await signalAdapter.loadConversations({
      signalDbPath: SIGNAL_DB,
      signalConfigPath: SIGNAL_CONFIG,
      start: new Date("2020-01-01T00:00:00Z"),
      end: new Date("2021-01-01T00:00:00Z"),
      myName: "Me",
      includeEmpty: false,
    });
    // All conversations should be dropped (no messages in this range)
    expect(allConversations).toHaveLength(0);
  });

  test("throws SignalKeyError when DB path does not exist", async () => {
    await expect(
      signalAdapter.loadConversations({
        signalDbPath: "/nonexistent/path/db.sqlite",
        signalConfigPath: SIGNAL_CONFIG,
      }),
    ).rejects.toThrow(/not found/i);
  });

  test("system message types (call-history) are filtered out by SQL", async () => {
    const conversations = await signalAdapter.loadConversations({
      signalDbPath: SIGNAL_DB,
      signalConfigPath: SIGNAL_CONFIG,
      start: new Date("2024-01-01T00:00:00Z"),
      end: new Date("2025-01-01T00:00:00Z"),
      myName: "Me",
    });

    const alice = conversations.find((c) => c.conversationId === "conv-1");
    // msg-4 is "call-history" type — must be absent
    const callMsg = alice?.messages.find((m) => m.text === "call started");
    expect(callMsg).toBeUndefined();
    // Only 2 messages (incoming + outgoing)
    expect(alice?.messages).toHaveLength(2);
  });

  test("group conversation is loaded with correct participants", async () => {
    const conversations = await signalAdapter.loadConversations({
      signalDbPath: SIGNAL_DB,
      signalConfigPath: SIGNAL_CONFIG,
      start: new Date("2024-01-01T00:00:00Z"),
      end: new Date("2025-01-01T00:00:00Z"),
    });

    const group = conversations.find((c) => c.conversationId === "conv-2");
    expect(group).toBeDefined();
    expect(group?.title).toBe("Work Group");
    expect(group?.messages).toHaveLength(1);
  });
});

describe("SignalDatabaseBusyError", () => {
  test("is an instance of TransientAdapterError", () => {
    const err = new SignalDatabaseBusyError("locked");
    expect(err).toBeInstanceOf(TransientAdapterError);
    expect(err.name).toBe("SignalDatabaseBusyError");
    expect(err.source).toBe("signal");
  });

  // Simulate the SQLCipher driver reporting `SQLITE_BUSY` at open time by
  // poisoning the CommonJS require.cache for `better-sqlite3-multiple-ciphers`
  // with a stub constructor. The adapter resolves the native module lazily via
  // `createRequire(import.meta.url)`, so this real-module swap exercises the
  // actual adapter code path — we ARE invoking `signalAdapter.loadConversations`,
  // not just constructing the error class.
  //
  // Why not a real filesystem lock? The adapter copies the DB with
  // `fs.copyFileSync` before opening, and on macOS/Linux that raw-bytes copy
  // bypasses SQLite's advisory locks — so a sibling write transaction against
  // the fixture cannot surface SQLITE_BUSY at the open site. The cache swap is
  // the smallest change that still runs the adapter's error-mapping branch.
  describe("BUSY from native SQLCipher driver", () => {
    const req = createRequire(import.meta.url);
    const nativePath = req.resolve("better-sqlite3-multiple-ciphers");
    const original = req.cache[nativePath];

    afterEach(() => {
      if (original) req.cache[nativePath] = original;
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      else delete req.cache[nativePath];
    });

    function installBusyStub(message: string): void {
      function BusyDatabase(): void {
        const err = new Error(message) as Error & { code?: string };
        err.code = "SQLITE_BUSY";
        throw err;
      }
      req.cache[nativePath] = {
        id: nativePath,
        path: path.dirname(nativePath),
        filename: nativePath,
        loaded: true,
        exports: BusyDatabase,
        children: [],
        paths: [],
        parent: null,
        require: req,
        isPreloading: false,
      } as unknown as NodeJS.Module;
    }

    test("SQLITE_BUSY on open is mapped to SignalDatabaseBusyError", async () => {
      installBusyStub("SQLITE_BUSY: database is locked");

      const promise = signalAdapter.loadConversations({
        signalDbPath: SIGNAL_DB,
        signalConfigPath: SIGNAL_CONFIG,
      });

      await expect(promise).rejects.toBeInstanceOf(SignalDatabaseBusyError);
      await expect(promise).rejects.toBeInstanceOf(TransientAdapterError);
      await expect(promise).rejects.toThrow(/locked/i);
    });

    test("non-BUSY errors are not remapped to SignalDatabaseBusyError", async () => {
      installBusyStub("SQLITE_CORRUPT: database image is malformed");

      await expect(
        signalAdapter.loadConversations({
          signalDbPath: SIGNAL_DB,
          signalConfigPath: SIGNAL_CONFIG,
        }),
      ).rejects.not.toBeInstanceOf(SignalDatabaseBusyError);
    });
  });
});
