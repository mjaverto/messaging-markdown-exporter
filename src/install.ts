#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import prompts from "prompts";
import { Command } from "commander";

import { AppConfig, CONFIG_VERSION, validateSchedule } from "./config.js";
import { runDoctor } from "./doctor.js";
import { expandHome } from "./utils.js";

const DEFAULT_INSTALL_DIR = path.join(os.homedir(), ".imessage-to-markdown");
const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), "brain", "inbox", "messages");
const DEFAULT_DB = path.join(os.homedir(), "Library", "Messages", "chat.db");
const LABEL = "ai.aver.to.imessage-to-markdown";

export function buildRunnerScript(configPath: string): string {
  return `#!/bin/zsh
set -euo pipefail
# launchd runs agents with a minimal PATH that does not include node, jq,
# or Homebrew binaries. Export a PATH that covers both Apple Silicon and
# Intel Homebrew prefixes so \`node\`, \`pmset\`, etc. resolve.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
CONFIG_PATH=${JSON.stringify(configPath)}
if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Missing config: $CONFIG_PATH" >&2
  exit 1
fi
node --input-type=module <<'EOF'
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const config = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf8"));
if (config.acPowerOnly) {
  const power = execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" });
  if (power.includes("Battery Power")) {
    console.log("On battery power, skipping export");
    process.exit(0);
  }
}
process.chdir(config.repoDir);
const sources = Array.isArray(config.enabledSources) && config.enabledSources.length > 0
  ? config.enabledSources
  : [config.source];
// Exit-code contract with the CLI:
//   0  = success (or no-op day with zero messages)
//   75 = transient failure (DB locked, network blip) — keep going
//   78 = permanent failure (auth revoked, config missing) — notify the user
//   *  = unknown error — treat as permanent for safety
let anyPermanent = false;
let anyTransient = false;
let successes = 0;
const permanentSources = [];
for (const source of sources) {
  const sourceOutputDir = sources.length > 1 ? \`\${config.outputDir}/\${source}\` : config.outputDir;
  const args = ["dist/cli.js", "--source", source, "--output-dir", sourceOutputDir, "--my-name", config.myName];
  if (source === "imessage") {
    args.push("--db-path", config.dbPath);
    if (config.includeEmpty) args.push("--include-empty");
  } else if (source === "telegram") {
    if (config.telegramConfigDir) args.push("--telegram-config-dir", config.telegramConfigDir);
  } else if (source === "whatsapp") {
    if (config.whatsappDbPath) args.push("--whatsapp-db-path", config.whatsappDbPath);
  } else if (source === "signal") {
    if (config.signalDbPath) args.push("--signal-db-path", config.signalDbPath);
    if (config.signalConfigPath) args.push("--signal-config-path", config.signalConfigPath);
  } else if (config.exportPath) {
    args.push("--export-path", config.exportPath);
  }
  try {
    execFileSync("node", args, { stdio: "inherit" });
    successes++;
  } catch (err) {
    const code = err && typeof err.status === "number" ? err.status : 1;
    if (code === 75) {
      anyTransient = true;
      console.warn(\`[runner] \${source} transient failure (exit 75); will retry next tick\`);
    } else {
      anyPermanent = true;
      permanentSources.push(source);
      console.error(\`[runner] \${source} permanent failure (exit \${code}); user action required\`);
    }
  }
}
if (config.runQmdEmbed && config.qmdCommand) {
  // Skip qmd-embed if every adapter failed this tick. Otherwise
  // qmd-embed would process leftover/stale markdown from prior runs
  // and mask the underlying adapter failure.
  if (successes === 0) {
    console.warn("[runner] all adapters failed this tick; skipping qmd-embed");
  } else {
    try {
      execFileSync("bash", ["-lc", config.qmdCommand], { stdio: "inherit" });
    } catch (err) {
      anyPermanent = true;
      permanentSources.push("qmd-embed");
      console.error(\`[runner] qmd-embed failed: \${err && err.message}\`);
    }
  }
}
if (anyPermanent) {
  try {
    const msg = \`imessage-to-markdown: \${permanentSources.join(", ")} need attention\`;
    execFileSync("osascript", ["-e", \`display notification "\${msg}" with title "imessage-to-markdown"\`], { stdio: "ignore" });
  } catch {
    // osascript failure is non-fatal — the nonzero exit still surfaces via launchd
  }
  process.exit(1);
}
if (anyTransient) {
  // Propagate the transient signal so launchd's error stream records it,
  // but distinguish from permanent via the 75 exit code.
  process.exit(75);
}
EOF
`;
}

export function buildPlist(
  scriptPath: string,
  configPath: string,
  hour: number,
  minute: number,
): string {
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
    <key>EnvironmentVariables</key>
    <dict>
      <key>CONFIG_PATH</key>
      <string>${configPath}</string>
    </dict>
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

function writeInstallFiles(config: AppConfig): {
  configPath: string;
  scriptPath: string;
  plistPath: string;
} {
  fs.mkdirSync(config.installDir, { recursive: true });
  const configPath = path.join(config.installDir, "config.json");
  const scriptPath = path.join(config.installDir, "run-export.sh");
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  fs.writeFileSync(scriptPath, buildRunnerScript(configPath), { mode: 0o755 });
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(
    plistPath,
    buildPlist(scriptPath, configPath, config.scheduleHour, config.scheduleMinute),
  );
  return { configPath, scriptPath, plistPath };
}

function currentGuiDomain(): string {
  const getuid = process.getuid;
  if (!getuid) throw new Error("process.getuid() is not available on this platform.");
  return `gui/${getuid.call(process)}`;
}

function loadLaunchAgent(plistPath: string): void {
  const domain = currentGuiDomain();
  try {
    execFileSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
  } catch {
    // Ignore: the agent may not be loaded yet on a first install.
  }
  execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "inherit" });
}

function unloadLaunchAgent(plistPath: string): void {
  const domain = currentGuiDomain();
  try {
    execFileSync("launchctl", ["bootout", domain, plistPath], { stdio: "inherit" });
  } catch {
    // Ignore: the agent may already be unloaded; uninstall should be idempotent.
  }
}

function buildConfig(input: {
  source: string;
  outputDir: string;
  exportPath?: string;
  schedule: string;
  runQmdEmbed: boolean;
  qmdCommand?: string;
  acPowerOnly: boolean;
  dbPath: string;
  myName: string;
  includeEmpty: boolean;
  installDir: string;
}): AppConfig {
  const { hour, minute } = validateSchedule(input.schedule);
  return {
    version: CONFIG_VERSION,
    source: input.source,
    outputDir: expandHome(input.outputDir),
    exportPath: input.exportPath ? expandHome(input.exportPath) : undefined,
    scheduleHour: hour,
    scheduleMinute: minute,
    runQmdEmbed: input.runQmdEmbed,
    qmdCommand: input.qmdCommand,
    acPowerOnly: input.acPowerOnly,
    dbPath: expandHome(input.dbPath),
    myName: input.myName,
    includeEmpty: input.includeEmpty,
    installDir: expandHome(input.installDir),
    repoDir: process.cwd(),
  };
}

async function resolveConfig(): Promise<AppConfig> {
  const program = new Command();
  program
    .option("--source <name>", "Source adapter to schedule", "imessage")
    .option("--output-dir <path>")
    .option("--export-path <path>")
    .option("--schedule <hh:mm>", "Daily schedule time", "05:30")
    .option("--run-qmd-embed")
    .option("--qmd-command <command>")
    .option("--ac-power-only")
    .option("--db-path <path>", undefined, DEFAULT_DB)
    .option("--my-name <name>", "Mike")
    .option("--include-empty")
    .option("--install-dir <path>", DEFAULT_INSTALL_DIR)
    .option("--yes", "Skip prompts")
    .option("--doctor", "Run dependency/path checks before installing")
    .option("--uninstall", "Remove installed launchd job and local install files");
  program.parse(process.argv);
  const cli = program.opts();

  if (cli.uninstall) {
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    unloadLaunchAgent(plistPath);
    fs.rmSync(expandHome(String(cli.installDir || DEFAULT_INSTALL_DIR)), {
      recursive: true,
      force: true,
    });
    fs.rmSync(plistPath, { force: true });
    console.log("Uninstalled imessage-to-markdown launchd job.");
    process.exit(0);
  }

  if (cli.doctor) {
    const doctor = runDoctor({
      sources: [String(cli.source || "imessage")],
      dbPath: expandHome(String(cli.dbPath || DEFAULT_DB)),
      exportPath: cli.exportPath ? expandHome(String(cli.exportPath)) : undefined,
    });
    for (const warning of doctor.warnings) console.log(`- ${warning}`);
  }

  if (cli.yes) {
    return buildConfig({
      source: String(cli.source || "imessage"),
      outputDir: cli.outputDir || DEFAULT_OUTPUT_DIR,
      exportPath: cli.exportPath,
      schedule: cli.schedule,
      runQmdEmbed: Boolean(cli.runQmdEmbed),
      qmdCommand: cli.qmdCommand,
      acPowerOnly: Boolean(cli.acPowerOnly),
      dbPath: String(cli.dbPath || DEFAULT_DB),
      myName: cli.myName,
      includeEmpty: Boolean(cli.includeEmpty),
      installDir: cli.installDir || DEFAULT_INSTALL_DIR,
    });
  }

  const response = await prompts([
    {
      type: "select",
      name: "source",
      message: "Which source should this scheduled job export?",
      choices: [
        { title: "iMessage", value: "imessage" },
        { title: "Telegram", value: "telegram" },
        { title: "WhatsApp", value: "whatsapp" },
        { title: "Signal", value: "signal" },
      ],
      initial: 0,
    },
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
      validate: (value: string) => {
        try {
          validateSchedule(value);
          return true;
        } catch (error) {
          return error instanceof Error ? error.message : "Invalid schedule";
        }
      },
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
      type: (prev, values) => (values.source === "imessage" ? "text" : null),
      name: "myName",
      message: "What should sent iMessages be labeled as?",
      initial: cli.myName || "Mike",
    },
  ]);

  return buildConfig({
    source: response.source || cli.source || "imessage",
    outputDir: response.outputDir || cli.outputDir || DEFAULT_OUTPUT_DIR,
    exportPath: cli.exportPath,
    schedule: response.schedule || cli.schedule,
    runQmdEmbed: Boolean(response.runQmdEmbed),
    qmdCommand: response.qmdCommand || cli.qmdCommand,
    acPowerOnly: Boolean(response.acPowerOnly),
    dbPath: String(cli.dbPath || DEFAULT_DB),
    myName: response.myName || cli.myName || "Mike",
    includeEmpty: Boolean(cli.includeEmpty),
    installDir: cli.installDir || DEFAULT_INSTALL_DIR,
  });
}

export async function main(): Promise<void> {
  const config = await resolveConfig();
  const doctor = runDoctor({
    sources:
      config.enabledSources && config.enabledSources.length > 0
        ? config.enabledSources
        : [config.source],
    dbPath: config.dbPath,
    exportPath: config.exportPath,
    whatsappDbPath: config.whatsappDbPath,
    signalDbPath: config.signalDbPath,
    signalConfigPath: config.signalConfigPath,
    telegramConfigDir: config.telegramConfigDir,
  });
  for (const warning of doctor.warnings) console.log(`- ${warning}`);
  const { plistPath, configPath } = writeInstallFiles(config);
  loadLaunchAgent(plistPath);
  console.log(`Installed launchd agent: ${LABEL}`);
  console.log(`Config: ${configPath}`);
  console.log(`Source: ${config.source}`);
  console.log(`Output dir: ${config.outputDir}`);
  if (config.exportPath) console.log(`Export path: ${config.exportPath}`);
  console.log(`Repo dir: ${config.repoDir}`);
  console.log(
    `Schedule: ${String(config.scheduleHour).padStart(2, "0")}:${String(config.scheduleMinute).padStart(2, "0")}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
