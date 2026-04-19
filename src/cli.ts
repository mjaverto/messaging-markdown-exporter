#!/usr/bin/env node
import { Command } from "commander";

import { exportMarkdown } from "./exporter.js";
import { expandHome } from "./utils.js";

function parseDate(input: string | undefined, fallback: Date): Date {
  if (!input) return fallback;
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${input}`);
  return parsed;
}

export function main(argv = process.argv): void {
  const program = new Command();
  program
    .name("imessage-to-markdown")
    .description("Export Apple Messages/iMessage to markdown")
    .option("--db-path <path>", "Path to chat.db", "~/Library/Messages/chat.db")
    .option("--output-dir <path>", "Directory for markdown output", "./exports")
    .option("--days <days>", "Export last N days", "1")
    .option("--start <iso>", "Start datetime ISO8601")
    .option("--end <iso>", "End datetime ISO8601")
    .option("--my-name <name>", "Label for sent messages", "Mike")
    .option("--exclude-chat-regex <regex>", "Regex to exclude chats by name")
    .option("--include-system", "Include system-ish chats")
    .option("--include-empty", "Include empty messages with only metadata")
    .option("--json", "Print JSON summary")
    .parse(argv);

  const options = program.opts();
  const end = parseDate(options.end, new Date());
  const start = parseDate(options.start, new Date(end.getTime() - Number(options.days) * 24 * 60 * 60 * 1000));

  const result = exportMarkdown({
    dbPath: expandHome(options.dbPath),
    outputDir: expandHome(options.outputDir),
    start,
    end,
    myName: options.myName,
    excludeChatRegex: options.excludeChatRegex,
    skipSystem: !options.includeSystem,
    includeEmpty: Boolean(options.includeEmpty),
  });

  const summary = {
    filesWritten: result.filesWritten,
    messagesExported: result.messagesExported,
    outputPaths: result.outputPaths,
    start: start.toISOString(),
    end: end.toISOString(),
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Wrote ${result.filesWritten} file(s), exported ${result.messagesExported} message(s).`);
    for (const out of result.outputPaths) console.log(out);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
