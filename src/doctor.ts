import fs from "node:fs";
import { execFileSync } from "node:child_process";

export interface DoctorCheckResult {
  ok: boolean;
  warnings: string[];
}

export interface DoctorInput {
  sources: string[];
  dbPath: string;
  exportPath?: string;
  whatsappDbPath?: string;
  signalDbPath?: string;
  signalConfigPath?: string;
  telegramConfigDir?: string;
}

function hasCommand(command: string): boolean {
  try {
    execFileSync("bash", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function checkSource(source: string, input: DoctorInput, warnings: string[]): void {
  if (source === "imessage") {
    if (!hasCommand("sqlite3"))
      warnings.push(
        "sqlite3 is not on PATH. The iMessage adapter shells out to sqlite3 to read chat.db.",
      );
    if (!fs.existsSync(input.dbPath))
      warnings.push(
        `Messages database not found at ${input.dbPath}. Full Disk Access or path may be wrong.`,
      );
    warnings.push(
      "Reminder: the terminal or app running this tool needs Full Disk Access to read ~/Library/Messages/chat.db.",
    );
    return;
  }
  if (source === "whatsapp") {
    if (!hasCommand("sqlite3"))
      warnings.push(
        "sqlite3 is not on PATH. The WhatsApp adapter shells out to sqlite3 to read ChatStorage.sqlite.",
      );
    if (input.whatsappDbPath && !fs.existsSync(input.whatsappDbPath)) {
      warnings.push(
        `WhatsApp database not found at ${input.whatsappDbPath}. WhatsApp Desktop must be installed and Full Disk Access granted.`,
      );
    }
    return;
  }
  if (source === "signal") {
    if (input.signalDbPath && !fs.existsSync(input.signalDbPath)) {
      warnings.push(
        `Signal database not found at ${input.signalDbPath}. Signal Desktop must be installed and Full Disk Access granted.`,
      );
    }
    if (input.signalConfigPath && !fs.existsSync(input.signalConfigPath)) {
      warnings.push(
        `Signal config not found at ${input.signalConfigPath}; required to derive the SQLCipher key.`,
      );
    }
    return;
  }
  if (source === "telegram") {
    if (input.telegramConfigDir && !fs.existsSync(input.telegramConfigDir)) {
      warnings.push(
        `Telegram config dir not found at ${input.telegramConfigDir}. Run 'imessage-to-markdown telegram-login' first.`,
      );
    }
    return;
  }
  if (input.exportPath && !fs.existsSync(input.exportPath)) {
    warnings.push(`Export path not found at ${input.exportPath}.`);
  }
}

export function runDoctor(input: DoctorInput): DoctorCheckResult {
  const warnings: string[] = [];
  if (!hasCommand("node")) warnings.push("Node.js is not on PATH.");
  const sources = input.sources.length > 0 ? input.sources : ["imessage"];
  for (const source of sources) checkSource(source, input, warnings);
  return { ok: warnings.length === 0, warnings };
}
