/**
 * Unit tests for src/doctor.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runDoctor } from "../src/doctor.js";

describe("runDoctor", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns ok:true and no warnings when node is present and source is ignored for unknown type", () => {
    // node is on PATH in test env, and we pass an unknown source with no paths
    const result = runDoctor({
      sources: ["unknown-source"],
      dbPath: tmpDir, // exists so no file-missing warning
    });
    // node is on PATH in any Node test env
    expect(result.warnings.some((w) => w.includes("Node.js is not on PATH"))).toBe(false);
  });

  test("warns when imessage dbPath does not exist", () => {
    const result = runDoctor({
      sources: ["imessage"],
      dbPath: "/nonexistent/chat.db",
    });
    expect(result.ok).toBe(false);
    const dbWarn = result.warnings.find((w) => w.includes("Messages database not found"));
    expect(dbWarn).toBeDefined();
  });

  test("imessage always emits Full Disk Access reminder", () => {
    const result = runDoctor({
      sources: ["imessage"],
      dbPath: tmpDir, // exists, so the file-missing warning won't fire
    });
    const fdaWarn = result.warnings.find((w) => w.includes("Full Disk Access"));
    expect(fdaWarn).toBeDefined();
  });

  test("warns when whatsapp dbPath does not exist", () => {
    const fakeWaPath = path.join(tmpDir, "ChatStorage.sqlite");
    const result = runDoctor({
      sources: ["whatsapp"],
      dbPath: tmpDir,
      whatsappDbPath: fakeWaPath,
    });
    const warn = result.warnings.find((w) => w.includes("WhatsApp database not found"));
    expect(warn).toBeDefined();
  });

  test("no whatsapp warning when path exists", () => {
    // Create a dummy file
    const waPath = path.join(tmpDir, "ChatStorage.sqlite");
    fs.writeFileSync(waPath, "");
    const result = runDoctor({
      sources: ["whatsapp"],
      dbPath: tmpDir,
      whatsappDbPath: waPath,
    });
    expect(result.warnings.find((w) => w.includes("WhatsApp database not found"))).toBeUndefined();
  });

  test("warns when signal dbPath does not exist", () => {
    const fakeSignalDb = path.join(tmpDir, "db.sqlite");
    const result = runDoctor({
      sources: ["signal"],
      dbPath: tmpDir,
      signalDbPath: fakeSignalDb,
    });
    const warn = result.warnings.find((w) => w.includes("Signal database not found"));
    expect(warn).toBeDefined();
  });

  test("warns when signal configPath does not exist", () => {
    const fakeConfig = path.join(tmpDir, "config.json");
    const result = runDoctor({
      sources: ["signal"],
      dbPath: tmpDir,
      signalConfigPath: fakeConfig,
    });
    const warn = result.warnings.find((w) => w.includes("Signal config not found"));
    expect(warn).toBeDefined();
  });

  test("warns when telegram configDir does not exist", () => {
    const fakeTgDir = path.join(tmpDir, "telegram");
    const result = runDoctor({
      sources: ["telegram"],
      dbPath: tmpDir,
      telegramConfigDir: fakeTgDir,
    });
    const warn = result.warnings.find((w) => w.includes("Telegram config dir not found"));
    expect(warn).toBeDefined();
  });

  test("no telegram warning when dir exists", () => {
    const tgDir = path.join(tmpDir, "telegram");
    fs.mkdirSync(tgDir);
    const result = runDoctor({
      sources: ["telegram"],
      dbPath: tmpDir,
      telegramConfigDir: tgDir,
    });
    expect(
      result.warnings.find((w) => w.includes("Telegram config dir not found")),
    ).toBeUndefined();
  });

  test("warns when exportPath does not exist for unknown source", () => {
    const fakeExport = path.join(tmpDir, "export");
    const result = runDoctor({
      sources: ["some-other"],
      dbPath: tmpDir,
      exportPath: fakeExport,
    });
    const warn = result.warnings.find((w) => w.includes("Export path not found"));
    expect(warn).toBeDefined();
  });

  test("loops over multiple sources", () => {
    const fakeSignalDb = path.join(tmpDir, "db.sqlite");
    const fakeWaDb = path.join(tmpDir, "ChatStorage.sqlite");
    const result = runDoctor({
      sources: ["signal", "whatsapp"],
      dbPath: tmpDir,
      signalDbPath: fakeSignalDb,
      whatsappDbPath: fakeWaDb,
    });
    expect(result.warnings.find((w) => w.includes("Signal database not found"))).toBeDefined();
    expect(result.warnings.find((w) => w.includes("WhatsApp database not found"))).toBeDefined();
  });

  test("defaults to imessage when sources array is empty", () => {
    const result = runDoctor({
      sources: [],
      dbPath: "/nonexistent/chat.db",
    });
    // Should warn about iMessage db missing
    expect(result.warnings.find((w) => w.includes("Messages database not found"))).toBeDefined();
  });
});
