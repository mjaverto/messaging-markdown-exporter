/**
 * Unit tests for src/exporter.ts (exportFromSource).
 *
 * Uses the synthetic fixtures so no real user data is needed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { exportFromSource } from "../src/exporter.js";

const FIXTURES = path.join(process.cwd(), "test", "fixtures");
const IMESSAGE_DB = path.join(FIXTURES, "imessage.chat.db");
const SIGNAL_DB = path.join(FIXTURES, "signal.db");
const SIGNAL_CONFIG = path.join(FIXTURES, "signal-config.json");
const WHATSAPP_DB = path.join(FIXTURES, "whatsapp.ChatStorage.sqlite");

describe("exportFromSource", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "exporter-test-"));
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  test("throws for unknown source", async () => {
    await expect(exportFromSource("unknown-source", { outputDir })).rejects.toThrow(
      /unknown source/i,
    );
  });

  test("exports imessage fixture to markdown files", async () => {
    const result = await exportFromSource("imessage", {
      dbPath: IMESSAGE_DB,
      outputDir,
      start: new Date("2024-01-01T00:00:00Z"),
      end: new Date("2025-01-01T00:00:00Z"),
      myName: "Me",
      includeEmpty: false,
      useContacts: false,
    });

    expect(result.filesWritten).toBeGreaterThan(0);
    expect(result.outputPaths.length).toBe(result.filesWritten);
    // All output paths should be under outputDir
    for (const p of result.outputPaths) {
      expect(p.startsWith(outputDir)).toBe(true);
    }
    // Verify at least one markdown file was actually written
    const files = result.outputPaths;
    expect(files.every((p) => p.endsWith(".md"))).toBe(true);
    const content = fs.readFileSync(files[0]!, "utf8");
    expect(content).toContain("---");
    expect(content).toContain("source:");
  });

  test("exports signal fixture to markdown files", async () => {
    const result = await exportFromSource("signal", {
      signalDbPath: SIGNAL_DB,
      signalConfigPath: SIGNAL_CONFIG,
      outputDir,
      start: new Date("2024-01-01T00:00:00Z"),
      end: new Date("2025-01-01T00:00:00Z"),
      myName: "Me",
      useContacts: false,
    });

    expect(result.filesWritten).toBeGreaterThan(0);
    const content = fs.readFileSync(result.outputPaths[0]!, "utf8");
    expect(content).toContain('source: "signal"');
  });

  test("exports whatsapp fixture to markdown files", async () => {
    const result = await exportFromSource("whatsapp", {
      whatsappDbPath: WHATSAPP_DB,
      outputDir,
      start: new Date("2024-01-01T00:00:00Z"),
      end: new Date("2025-01-01T00:00:00Z"),
      myName: "Me",
      useContacts: false,
    });

    expect(result.filesWritten).toBeGreaterThan(0);
    const content = fs.readFileSync(result.outputPaths[0]!, "utf8");
    expect(content).toContain('source: "whatsapp"');
  });

  test("returns zero filesWritten when no conversations in date range", async () => {
    const result = await exportFromSource("imessage", {
      dbPath: IMESSAGE_DB,
      outputDir,
      start: new Date("2020-01-01T00:00:00Z"),
      end: new Date("2021-01-01T00:00:00Z"),
      myName: "Me",
      useContacts: false,
    });

    expect(result.filesWritten).toBe(0);
  });

  test("overwrites existing files on second run (no duplicates)", async () => {
    const sharedOptions = {
      dbPath: IMESSAGE_DB,
      outputDir,
      start: new Date("2024-01-01T00:00:00Z"),
      end: new Date("2025-01-01T00:00:00Z"),
      myName: "Me",
      useContacts: false,
    };

    const first = await exportFromSource("imessage", sharedOptions);
    const second = await exportFromSource("imessage", sharedOptions);

    // Same number of files
    expect(second.filesWritten).toBe(first.filesWritten);
    // Same paths
    expect(second.outputPaths.sort()).toEqual(first.outputPaths.sort());
    // No duplicate files (same content, same paths means overwrite not append)
    const fileSet = new Set(second.outputPaths);
    expect(fileSet.size).toBe(second.filesWritten);
  });
});
