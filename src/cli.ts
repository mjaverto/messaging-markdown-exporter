#!/usr/bin/env node
import os from "node:os";
import path from "node:path";

import { Command } from "commander";
import prompts from "prompts";

import { exportFromSource } from "./exporter.js";
import {
  ensureConfigDir,
  getTelegramConfigPaths,
  writeCredentials,
  writeSession,
} from "./adapters/telegram.js";
import { expandHome } from "./utils.js";

function parseDate(input: string | undefined, fallback: Date): Date {
  if (!input) return fallback;
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${input}`);
  return parsed;
}

const DEFAULT_SIGNAL_DB = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Signal",
  "sql",
  "db.sqlite",
);
const DEFAULT_WHATSAPP_DB = path.join(
  os.homedir(),
  "Library",
  "Group Containers",
  "group.net.whatsapp.WhatsApp.shared",
  "ChatStorage.sqlite",
);

async function runTelegramLogin(): Promise<void> {
  ensureConfigDir();
  const paths = getTelegramConfigPaths();
  console.log(
    "Telegram one-time login. Get apiId and apiHash from https://my.telegram.org/apps.",
  );
  const answers = await prompts([
    { type: "number", name: "apiId", message: "apiId (integer)" },
    { type: "text", name: "apiHash", message: "apiHash" },
    { type: "text", name: "phone", message: "Phone number (E.164, e.g. +15551234567)" },
  ]);
  if (!answers.apiId || !answers.apiHash || !answers.phone) {
    throw new Error("apiId, apiHash, and phone are required.");
  }
  writeCredentials({ apiId: Number(answers.apiId), apiHash: String(answers.apiHash) });

  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");

  const client = new TelegramClient(
    new StringSession(""),
    Number(answers.apiId),
    String(answers.apiHash),
    { connectionRetries: 5 },
  );
  await client.start({
    phoneNumber: async () => String(answers.phone),
    phoneCode: async () => {
      const r = await prompts({ type: "text", name: "code", message: "Login code from Telegram" });
      return String(r.code);
    },
    password: async () => {
      const r = await prompts({ type: "password", name: "pw", message: "2FA password (blank if none)" });
      return String(r.pw || "");
    },
    onError: (err: Error) => console.error("Telegram login error:", err.message),
  });
  const session = String(client.session.save() ?? "");
  writeSession(session);
  await client.disconnect();
  console.log(
    `Telegram authenticated. Session saved to ${paths.sessionPath}. ` +
      "You can now run with --source telegram from cron.",
  );
}

export async function main(argv = process.argv): Promise<void> {
  // Subcommand: telegram-login (NOT a --source flag)
  if (argv[2] === "telegram-login") {
    await runTelegramLogin();
    return;
  }

  const program = new Command();
  program
    .name("imessage-to-markdown")
    .description("Export multiple messaging sources to markdown")
    .requiredOption("--source <name>", "Source adapter: imessage | telegram | whatsapp | signal")
    .option("--db-path <path>", "Path to iMessage chat.db", "~/Library/Messages/chat.db")
    .option(
      "--signal-db-path <path>",
      "Path to Signal Desktop SQLCipher DB",
      DEFAULT_SIGNAL_DB,
    )
    .option(
      "--whatsapp-db-path <path>",
      "Path to WhatsApp ChatStorage.sqlite",
      DEFAULT_WHATSAPP_DB,
    )
    .option(
      "--export-path <path>",
      "[Deprecated for signal/whatsapp] Path to a static export file or directory",
    )
    .option("--output-dir <path>", "Directory for markdown output", "./exports")
    .option("--days <days>", "Export last N days", "1")
    .option("--start <iso>", "Start datetime ISO8601")
    .option("--end <iso>", "End datetime ISO8601")
    .option("--my-name <name>", "Label for sent messages", "Mike")
    .option("--include-empty", "Include empty messages with only metadata")
    .option("--no-contacts", "Skip Contacts.app lookup; do not resolve names")
    .option("--use-contact-names", "Use resolved contact names as filenames for 1:1 chats")
    .parse(argv);

  const options = program.opts();
  const end = parseDate(options.end, new Date());
  const start = parseDate(options.start, new Date(end.getTime() - Number(options.days) * 24 * 60 * 60 * 1000));
  // commander's --no-contacts flips opts.contacts to false; default is true.
  const useContacts = options.contacts !== false;

  // Pick the source-specific DB path so each adapter can stay agnostic of CLI shape.
  const sourceDbPath = (() => {
    switch (options.source) {
      case "imessage":
        return expandHome(options.dbPath);
      case "signal":
        return expandHome(options.signalDbPath);
      case "whatsapp":
        return expandHome(options.whatsappDbPath);
      default:
        return undefined;
    }
  })();

  const result = await exportFromSource(String(options.source), {
    dbPath: sourceDbPath,
    exportPath: options.exportPath ? expandHome(options.exportPath) : undefined,
    outputDir: expandHome(options.outputDir),
    start,
    end,
    myName: options.myName,
    includeEmpty: Boolean(options.includeEmpty),
    useContacts,
    useContactNames: Boolean(options.useContactNames),
  });

  console.log(`Wrote ${result.filesWritten} file(s).`);
  for (const out of result.outputPaths.slice(0, 20)) console.log(out);
  if (result.outputPaths.length > 20) console.log(`...and ${result.outputPaths.length - 20} more`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
