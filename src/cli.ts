#!/usr/bin/env node
import { Command } from "commander";

import { DEFAULT_TELEGRAM_CONFIG_DIR } from "./adapters/telegram.js";
import {
  EXIT_PERMANENT,
  EXIT_TRANSIENT,
  PermanentAdapterError,
  TransientAdapterError,
} from "./core/model.js";
import { exportFromSource } from "./exporter.js";
import { SignalKeyError } from "./lib/signal-keychain.js";
import { telegramLogin } from "./telegram-login.js";
import { expandHome } from "./utils.js";

function parseDate(input: string | undefined, fallback: Date): Date {
  if (!input) return fallback;
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${input}`);
  return parsed;
}

export async function main(argv = process.argv): Promise<void> {
  const program = new Command();
  program
    .name("imessage-to-markdown")
    .description("Export multiple messaging sources to markdown");

  program
    .command("export", { isDefault: true })
    .description("Export messages from a source to markdown")
    .requiredOption("--source <name>", "Source adapter: imessage | telegram | whatsapp | signal")
    .option("--db-path <path>", "Path to iMessage chat.db", "~/Library/Messages/chat.db")
    .option("--export-path <path>", "Path to Telegram export")
    .option("--signal-db-path <path>", "Path to Signal Desktop db.sqlite", "~/Library/Application Support/Signal/sql/db.sqlite")
    .option("--signal-config-path <path>", "Path to Signal Desktop config.json", "~/Library/Application Support/Signal/config.json")
    .option(
      "--whatsapp-db-path <path>",
      "Path to WhatsApp ChatStorage.sqlite",
      "~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite",
    )
    .option("--output-dir <path>", "Directory for markdown output", "./exports")
    .option("--days <days>", "Export last N days for iMessage", "1")
    .option("--start <iso>", "Start datetime ISO8601")
    .option("--end <iso>", "End datetime ISO8601")
    .option("--my-name <name>", "Label for sent messages", "Mike")
    .option("--include-empty", "Include empty messages with only metadata")
    .option("--no-contacts", "Skip Contacts.app lookup; do not resolve names")
    .option("--use-contact-names", "Use resolved contact names as filenames for 1:1 chats")
    .option("--telegram-config-dir <path>", "Telegram config dir for credentials/session/cursors", DEFAULT_TELEGRAM_CONFIG_DIR)
    .action(async (options: Record<string, unknown>) => {
      const end = parseDate(options.end as string | undefined, new Date());
      const start = parseDate(
        options.start as string | undefined,
        new Date(end.getTime() - Number(options.days) * 24 * 60 * 60 * 1000),
      );
      const useContacts = options.contacts !== false;

      const result = await exportFromSource(String(options.source), {
        dbPath: expandHome(String(options.dbPath)),
        exportPath: options.exportPath ? expandHome(String(options.exportPath)) : undefined,
        signalDbPath: expandHome(String(options.signalDbPath)),
        signalConfigPath: expandHome(String(options.signalConfigPath)),
        whatsappDbPath: expandHome(String(options.whatsappDbPath)),
        outputDir: expandHome(String(options.outputDir)),
        start,
        end,
        myName: options.myName,
        includeEmpty: Boolean(options.includeEmpty),
        useContacts,
        useContactNames: Boolean(options.useContactNames),
        telegramConfigDir: options.telegramConfigDir,
      });

      console.log(`Wrote ${result.filesWritten} file(s).`);
      for (const out of result.outputPaths.slice(0, 20)) console.log(out);
      if (result.outputPaths.length > 20) console.log(`...and ${result.outputPaths.length - 20} more`);
    });

  program
    .command("telegram-login")
    .description("Interactive one-time auth for the Telegram adapter")
    .option(
      "--telegram-config-dir <path>",
      "Where to store credentials.json and session.txt",
      DEFAULT_TELEGRAM_CONFIG_DIR,
    )
    .action(async (options: { telegramConfigDir?: string }) => {
      await telegramLogin({ telegramConfigDir: options.telegramConfigDir });
    });

  await program.parseAsync(argv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    // Transient failures (DB locked while the owning app writes, network
    // blip) exit 75 (EX_TEMPFAIL). The runner logs but doesn't notify —
    // we expect the next scheduled tick to clear it.
    if (error instanceof TransientAdapterError) {
      console.warn(`warning [${error.source}]: ${error.message}`);
      process.exit(EXIT_TRANSIENT);
    }
    // Permanent failures (auth revoked, config missing) exit 78
    // (EX_CONFIG). The runner surfaces a macOS notification because
    // without user action the archive will never update again.
    if (error instanceof PermanentAdapterError) {
      console.error(`error [${error.source}]: ${error.message}`);
      process.exit(EXIT_PERMANENT);
    }
    if (error instanceof SignalKeyError) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    console.error(error);
    process.exit(1);
  });
}
