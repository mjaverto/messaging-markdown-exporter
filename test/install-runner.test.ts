/**
 * Unit tests for the launchd runner/plist builders in src/install.ts.
 *
 * Imports the real `buildRunnerScript` and `buildPlist` exports so the
 * template strings written by `npm run install:local` are exercised by
 * the test suite. Previously this file re-implemented the templates
 * inline, which gave zero coverage of src/install.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { validateSchedule } from "../src/config.js";
import { buildPlist, buildRunnerScript } from "../src/install.js";

describe("validateSchedule", () => {
  test("parses corner cases", () => {
    expect(validateSchedule("00:00")).toEqual({ hour: 0, minute: 0 });
    expect(validateSchedule("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(validateSchedule("5:30")).toEqual({ hour: 5, minute: 30 });
    expect(() => validateSchedule("24:00")).toThrow();
    expect(() => validateSchedule("12:60")).toThrow();
    expect(() => validateSchedule("abc")).toThrow();
    expect(() => validateSchedule("")).toThrow();
  });
});

describe("buildRunnerScript (real export from src/install.ts)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-runner-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("emits a zsh runner with per-source branches and exit-code contract", () => {
    const configPath = path.join(tmpDir, "config.json");
    const script = buildRunnerScript(configPath);

    expect(script.startsWith("#!/bin/zsh")).toBe(true);
    expect(script).toContain("set -euo pipefail");
    // PATH covers both Apple-Silicon and Intel Homebrew prefixes so the
    // launchd-minimal PATH doesn't lose `node` / `pmset`.
    expect(script).toContain("/opt/homebrew/bin");
    expect(script).toContain("/usr/local/bin");
    // Config path is embedded as a JSON string literal so a path with
    // spaces/quotes survives zsh expansion.
    expect(script).toContain(`CONFIG_PATH=${JSON.stringify(configPath)}`);
    expect(script).toContain("Missing config: $CONFIG_PATH");

    // All four source branches must be present — dropping one would
    // silently skip that adapter at runtime.
    expect(script).toContain('source === "imessage"');
    expect(script).toContain('source === "telegram"');
    expect(script).toContain('source === "whatsapp"');
    expect(script).toContain('source === "signal"');

    // Exit-code contract with the CLI: 75 = transient, 78 = permanent.
    expect(script).toContain("75");
    expect(script).toContain("78");
    expect(script).toContain("exit 75");
    // AC-power guard and qmd-embed orchestration must be embedded.
    expect(script).toContain("acPowerOnly");
    expect(script).toContain("qmd-embed");
    // Heredoc delimiter closes the embedded node script.
    expect(script).toContain("<<'EOF'");
    expect(script.trimEnd().endsWith("EOF")).toBe(true);
  });

  test("snapshot: runner script is stable for a known config path", () => {
    // Stable tmpdir replacement so the snapshot isn't per-run.
    const script = buildRunnerScript("/tmp/fixture-config.json");
    expect(script).toMatchSnapshot();
  });
});

describe("buildPlist (real export from src/install.ts)", () => {
  test("wires up label, script path, config path, and schedule", () => {
    const scriptPath = "/tmp/fixture-run-export.sh";
    const configPath = "/tmp/fixture-config.json";
    const plist = buildPlist(scriptPath, configPath, 5, 30);

    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain("<!DOCTYPE plist");
    expect(plist).toContain("ai.aver.to.imessage-to-markdown");
    expect(plist).toContain(`<string>${scriptPath}</string>`);
    expect(plist).toContain(`<string>${configPath}</string>`);
    expect(plist).toContain("<integer>5</integer>");
    expect(plist).toContain("<integer>30</integer>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("/tmp/imessage-to-markdown.out");
    expect(plist).toContain("/tmp/imessage-to-markdown.err");
  });

  test("snapshot: plist is stable for known inputs", () => {
    const plist = buildPlist("/tmp/fixture-run-export.sh", "/tmp/fixture-config.json", 5, 30);
    expect(plist).toMatchSnapshot();
  });

  test("accepts arbitrary hour/minute values", () => {
    const plist = buildPlist("/a", "/b", 23, 59);
    expect(plist).toContain("<integer>23</integer>");
    expect(plist).toContain("<integer>59</integer>");
  });
});
