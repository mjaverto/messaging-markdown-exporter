#!/usr/bin/env node
import { Command } from "commander";

import { SignalDatabaseBusyError } from "./adapters/signal.js";
import { exportFromSource } from "./exporter.js";
import { SignalKeyError } from "./lib/signal-keychain.js";
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
    .description("Export multiple messaging sources to markdown")
    .requiredOption("--source <name>", "Source adapter: imessage | telegram | whatsapp | signal")
    .option("--db-path <path>", "Path to iMessage chat.db", "~/Library/Messages/chat.db")
    .option("--export-path <path>", "Path to Telegram/WhatsApp export")
    .option("--signal-db-path <path>", "Path to Signal Desktop db.sqlite", "~/Library/Application Support/Signal/sql/db.sqlite")
    .option("--signal-config-path <path>", "Path to Signal Desktop config.json", "~/Library/Application Support/Signal/config.json")
    .option("--output-dir <path>", "Directory for markdown output", "./exports")
    .option("--days <days>", "Export last N days for iMessage", "1")
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

  const result = await exportFromSource(String(options.source), {
    dbPath: expandHome(options.dbPath),
    exportPath: options.exportPath ? expandHome(options.exportPath) : undefined,
    signalDbPath: options.signalDbPath ? expandHome(options.signalDbPath) : undefined,
    signalConfigPath: options.signalConfigPath ? expandHome(options.signalConfigPath) : undefined,
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
  main().catch((error: unknown) => {
    if (error instanceof SignalDatabaseBusyError) {
      // Treat a locked Signal DB as a soft failure: print a warning and exit 0
      // so scheduled runs while Signal is open don't spam errors.
      console.warn(`warning: ${error.message}`);
      process.exit(0);
    }
    if (error instanceof SignalKeyError) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    console.error(error);
    process.exit(1);
  });
}
