#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import prompts from "prompts";
import { Command } from "commander";

import { InstallOptions } from "./types.js";
import { expandHome } from "./utils.js";

const DEFAULT_INSTALL_DIR = path.join(os.homedir(), ".imessage-to-markdown");
const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), "brain", "inbox", "messages");
const DEFAULT_DB = path.join(os.homedir(), "Library", "Messages", "chat.db");
const LABEL = "ai.aver.to.imessage-to-markdown";

function buildRunnerScript(configPath: string): string {
  const configRef = "${CONFIG_PATH}";
  const installDirRef = "${INSTALL_DIR}";
  const outputDirRef = "${OUTPUT_DIR}";
  const dbPathRef = "${DB_PATH}";
  const myNameRef = "${MY_NAME}";
  const excludeRegexRef = "${EXCLUDE_REGEX}";
  const includeSystemRef = "${INCLUDE_SYSTEM}";
  const includeEmptyRef = "${INCLUDE_EMPTY}";
  const runQmdRef = "${RUN_QMD}";
  const qmdCommandRef = "${QMD_COMMAND}";
  const cmdRef = '"${CMD[@]}"';
  return [
    "#!/bin/zsh",
    "set -euo pipefail",
    `CONFIG_PATH=${JSON.stringify(configPath)}`,
    `INSTALL_DIR=$(dirname "${configRef}")`,
    `if [[ ! -f "${configRef}" ]]; then`,
    `  echo "Missing config: ${configRef}" >&2`,
    "  exit 1",
    "fi",
    `if /usr/bin/jq -e '.acPowerOnly == true' "${configRef}" >/dev/null 2>&1; then`,
    '  if pmset -g batt | head -n 1 | grep -q "Battery Power"; then',
    '    echo "On battery power, skipping export"',
    '    exit 0',
    '  fi',
    'fi',
    `OUTPUT_DIR=$(/usr/bin/jq -r '.outputDir' "${configRef}")`,
    `DB_PATH=$(/usr/bin/jq -r '.dbPath' "${configRef}")`,
    `MY_NAME=$(/usr/bin/jq -r '.myName' "${configRef}")`,
    `EXCLUDE_REGEX=$(/usr/bin/jq -r '.excludeChatRegex // empty' "${configRef}")`,
    `INCLUDE_SYSTEM=$(/usr/bin/jq -r '.includeSystem' "${configRef}")`,
    `INCLUDE_EMPTY=$(/usr/bin/jq -r '.includeEmpty' "${configRef}")`,
    `RUN_QMD=$(/usr/bin/jq -r '.runQmdEmbed' "${configRef}")`,
    `QMD_COMMAND=$(/usr/bin/jq -r '.qmdCommand // empty' "${configRef}")`,
    `cd "${installDirRef}"`,
    `CMD=(node dist/cli.js --output-dir "${outputDirRef}" --db-path "${dbPathRef}" --my-name "${myNameRef}")`,
    `if [[ -n "${excludeRegexRef}" ]]; then CMD+=(--exclude-chat-regex "${excludeRegexRef}"); fi`,
    `if [[ "${includeSystemRef}" == "true" ]]; then CMD+=(--include-system); fi`,
    `if [[ "${includeEmptyRef}" == "true" ]]; then CMD+=(--include-empty); fi`,
    cmdRef,
    `if [[ "${runQmdRef}" == "true" && -n "${qmdCommandRef}" ]]; then`,
    `  eval "${qmdCommandRef}"`,
    'fi',
    '',
  ].join("\n");
}

function buildPlist(scriptPath: string, hour: number, minute: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${scriptPath}</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>
      <integer>${hour}</integer>
      <key>Minute</key>
      <integer>${minute}</integer>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/imessage-to-markdown.out</string>
    <key>StandardErrorPath</key>
    <string>/tmp/imessage-to-markdown.err</string>
  </dict>
</plist>
`;
}

function ensureJq(): void {
  try {
    execFileSync("/usr/bin/jq", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error("jq is required for the generated launchd runner script. Install jq first.");
  }
}

function writeInstallFiles(options: InstallOptions): { configPath: string; scriptPath: string; plistPath: string } {
  fs.mkdirSync(options.installDir, { recursive: true });
  const configPath = path.join(options.installDir, "config.json");
  const scriptPath = path.join(options.installDir, "run-export.sh");
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  fs.writeFileSync(configPath, JSON.stringify(options, null, 2));
  fs.writeFileSync(scriptPath, buildRunnerScript(configPath), { mode: 0o755 });
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, buildPlist(scriptPath, options.scheduleHour, options.scheduleMinute));
  return { configPath, scriptPath, plistPath };
}

function loadLaunchAgent(plistPath: string): void {
  try {
    execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
  } catch {}
  execFileSync("launchctl", ["load", plistPath], { stdio: "inherit" });
}

async function resolveOptions(): Promise<InstallOptions> {
  const program = new Command();
  program
    .option("--output-dir <path>")
    .option("--schedule <hh:mm>", "Daily schedule time", "05:30")
    .option("--run-qmd-embed")
    .option("--qmd-command <command>")
    .option("--ac-power-only")
    .option("--db-path <path>", undefined, DEFAULT_DB)
    .option("--my-name <name>", "Mike")
    .option("--exclude-chat-regex <regex>")
    .option("--include-system")
    .option("--include-empty")
    .option("--install-dir <path>", DEFAULT_INSTALL_DIR)
    .option("--yes", "Skip prompts");
  program.parse(process.argv);
  const cli = program.opts();

  if (cli.yes) {
    const [hour, minute] = String(cli.schedule).split(":").map(Number);
    return {
      outputDir: expandHome(cli.outputDir || DEFAULT_OUTPUT_DIR),
      scheduleHour: hour,
      scheduleMinute: minute,
      runQmdEmbed: Boolean(cli.runQmdEmbed),
      qmdCommand: cli.qmdCommand,
      acPowerOnly: Boolean(cli.acPowerOnly),
      dbPath: expandHome(cli.dbPath || DEFAULT_DB),
      myName: cli.myName,
      excludeChatRegex: cli.excludeChatRegex,
      includeSystem: Boolean(cli.includeSystem),
      includeEmpty: Boolean(cli.includeEmpty),
      installDir: expandHome(cli.installDir || DEFAULT_INSTALL_DIR),
    };
  }

  const response = await prompts([
    {
      type: "text",
      name: "outputDir",
      message: "Where should exported markdown messages go?",
      initial: cli.outputDir || DEFAULT_OUTPUT_DIR,
    },
    {
      type: "text",
      name: "schedule",
      message: "What time should it run each day? (HH:MM)",
      initial: cli.schedule || "05:30",
    },
    {
      type: "confirm",
      name: "acPowerOnly",
      message: "Only run when the Mac is on AC power?",
      initial: true,
    },
    {
      type: "confirm",
      name: "runQmdEmbed",
      message: "Run qmd embed after export?",
      initial: false,
    },
    {
      type: (prev: boolean) => (prev ? "text" : null),
      name: "qmdCommand",
      message: "Command to run after export",
      initial: cli.qmdCommand || "qmd embed",
    },
    {
      type: "text",
      name: "myName",
      message: "What should sent messages be labeled as?",
      initial: cli.myName || "Mike",
    },
    {
      type: "text",
      name: "excludeChatRegex",
      message: "Regex for chats to skip, leave blank for none",
      initial: cli.excludeChatRegex || "Amazon|CVS|verification|OTP",
    },
  ]);

  const [hour, minute] = String(response.schedule).split(":").map(Number);
  return {
    outputDir: expandHome(response.outputDir || cli.outputDir || DEFAULT_OUTPUT_DIR),
    scheduleHour: hour,
    scheduleMinute: minute,
    runQmdEmbed: Boolean(response.runQmdEmbed),
    qmdCommand: response.qmdCommand || cli.qmdCommand,
    acPowerOnly: Boolean(response.acPowerOnly),
    dbPath: expandHome(cli.dbPath || DEFAULT_DB),
    myName: response.myName || cli.myName || "Mike",
    excludeChatRegex: response.excludeChatRegex || cli.excludeChatRegex,
    includeSystem: Boolean(cli.includeSystem),
    includeEmpty: Boolean(cli.includeEmpty),
    installDir: expandHome(cli.installDir || DEFAULT_INSTALL_DIR),
  };
}

export async function main(): Promise<void> {
  ensureJq();
  const options = await resolveOptions();
  const { plistPath, configPath } = writeInstallFiles(options);
  loadLaunchAgent(plistPath);
  console.log(`Installed launchd agent: ${LABEL}`);
  console.log(`Config: ${configPath}`);
  console.log(`Output dir: ${options.outputDir}`);
  console.log(`Schedule: ${String(options.scheduleHour).padStart(2, "0")}:${String(options.scheduleMinute).padStart(2, "0")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
