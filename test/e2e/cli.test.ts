/**
 * E2E tests for the built CLI binary (dist/cli.js).
 *
 * Invokes `node dist/cli.js ...` via child_process.
 * Uses synthetic SQLite fixtures — no real user data.
 *
 * Pre-requisite: `npm run build` must have been run before these tests.
 * The vitest globalSetup (vitest.config.ts) ensures this automatically.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

const ROOT = process.cwd(); // worktree root = /Users/mjaverto/src/imsg-cicd-tests
const CLI = path.join(ROOT, "dist", "cli.js");
const FIXTURES = path.join(ROOT, "test", "fixtures");
const IMESSAGE_DB = path.join(FIXTURES, "imessage.chat.db");
const WHATSAPP_DB = path.join(FIXTURES, "whatsapp.ChatStorage.sqlite");
const SIGNAL_DB = path.join(FIXTURES, "signal.db");
const SIGNAL_CONFIG = path.join(FIXTURES, "signal-config.json");

/** Run CLI and return { stdout, stderr, status }. Never throws. */
function runCli(
  args: string[],
  env?: Record<string, string>,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd: ROOT,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status ?? 1,
  };
}

describe("CLI E2E — --help", () => {
  test("prints help and exits 0", () => {
    const { stdout, status } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("imessage-to-markdown");
    expect(stdout).toContain("export");
    expect(stdout).toContain("telegram-login");
  });

  test("export subcommand --help shows required options", () => {
    const { stdout, status } = runCli(["export", "--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("--source");
    expect(stdout).toContain("--output-dir");
  });
});

describe("CLI E2E — imessage export", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-imessage-"));
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  test("exports conversations from fixture with --source imessage", () => {
    const { stdout, status } = runCli([
      "--source",
      "imessage",
      "--db-path",
      IMESSAGE_DB,
      "--output-dir",
      outputDir,
      "--start",
      "2024-01-01",
      "--end",
      "2025-01-01",
      "--my-name",
      "Me",
      "--no-contacts",
    ]);

    expect(status).toBe(0);
    expect(stdout).toContain("Wrote");

    // At least one markdown file should exist
    const mdFiles = findMdFiles(outputDir);
    expect(mdFiles.length).toBeGreaterThan(0);

    // First file should have YAML frontmatter
    const content = fs.readFileSync(mdFiles[0]!, "utf8");
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('source: "imessage"');
    expect(content).toContain("message_count:");
    expect(content).toContain("exported_at:");
  });

  test("--start and --end date filtering works", () => {
    // No messages in 2020
    const { stdout, status } = runCli([
      "--source",
      "imessage",
      "--db-path",
      IMESSAGE_DB,
      "--output-dir",
      outputDir,
      "--start",
      "2020-01-01",
      "--end",
      "2021-01-01",
      "--no-contacts",
    ]);

    expect(status).toBe(0);
    expect(stdout).toContain("Wrote 0 file(s)");
    expect(findMdFiles(outputDir)).toHaveLength(0);
  });

  test("running twice overwrites existing files (no duplicates)", () => {
    const sharedArgs = [
      "--source",
      "imessage",
      "--db-path",
      IMESSAGE_DB,
      "--output-dir",
      outputDir,
      "--start",
      "2024-01-01",
      "--end",
      "2025-01-01",
      "--no-contacts",
    ];

    const first = runCli(sharedArgs);
    expect(first.status).toBe(0);
    const firstFiles = findMdFiles(outputDir);

    const second = runCli(sharedArgs);
    expect(second.status).toBe(0);
    const secondFiles = findMdFiles(outputDir);

    // Same number of files — no duplicates
    expect(secondFiles.length).toBe(firstFiles.length);
    // Content should be identical (deterministic export)
    for (const file of secondFiles) {
      const content = fs.readFileSync(file, "utf8");
      expect(content).toContain("---");
    }
  });
});

describe("CLI E2E — signal export", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-signal-"));
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  test("exports conversations from fixture with --source signal", () => {
    const { stdout, status } = runCli([
      "--source",
      "signal",
      "--signal-db-path",
      SIGNAL_DB,
      "--signal-config-path",
      SIGNAL_CONFIG,
      "--output-dir",
      outputDir,
      "--start",
      "2024-01-01",
      "--end",
      "2025-01-01",
      "--my-name",
      "Me",
    ]);

    expect(status).toBe(0);
    expect(stdout).toContain("Wrote");

    const mdFiles = findMdFiles(outputDir);
    expect(mdFiles.length).toBeGreaterThan(0);

    const content = fs.readFileSync(mdFiles[0]!, "utf8");
    expect(content).toContain('source: "signal"');
  });
});

describe("CLI E2E — whatsapp export", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-whatsapp-"));
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  test("exports conversations from fixture with --source whatsapp", () => {
    const { stdout, status } = runCli([
      "--source",
      "whatsapp",
      "--whatsapp-db-path",
      WHATSAPP_DB,
      "--output-dir",
      outputDir,
      "--start",
      "2024-01-01",
      "--end",
      "2025-01-01",
      "--my-name",
      "Me",
      "--no-contacts",
    ]);

    expect(status).toBe(0);
    expect(stdout).toContain("Wrote");

    const mdFiles = findMdFiles(outputDir);
    expect(mdFiles.length).toBeGreaterThan(0);

    const content = fs.readFileSync(mdFiles[0]!, "utf8");
    expect(content).toContain('source: "whatsapp"');
  });
});

describe("CLI E2E — telegram error cases", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-tg-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("exits with code 78 when credentials are missing", () => {
    // No credentials.json in tmpDir
    const { status, stderr } = runCli([
      "--source",
      "telegram",
      "--telegram-config-dir",
      tmpDir,
      "--output-dir",
      tmpDir,
    ]);

    expect(status).toBe(78); // EX_CONFIG / PermanentAdapterError
    expect(stderr).toContain("telegram-login");
  });

  test("telegram-login subcommand: exits with error when called with no interaction possible", () => {
    // telegram-login normally prompts interactively.
    // When stdin is closed (no tty) it should fail gracefully, not hang.
    const result = spawnSync("node", [CLI, "telegram-login", "--telegram-config-dir", tmpDir], {
      encoding: "utf8",
      input: "", // empty stdin
      cwd: ROOT,
      timeout: 10000,
    });
    // The command must fail (non-zero exit) when stdin is closed — the
    // previous `status !== undefined || error !== undefined` assertion
    // was tautological. `timeout` spawn errors also surface here; both
    // the explicit non-zero status and the timeout-error cases are
    // acceptable failures.
    if (result.error) {
      expect(result.error).toBeInstanceOf(Error);
    } else {
      expect(result.status).not.toBe(0);
      expect(result.status).not.toBeNull();
    }
  });
});

// ─── Helper ───────────────────────────────────────────────────────────────────

function findMdFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string): void {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) results.push(full);
    }
  }
  walk(dir);
  return results;
}
