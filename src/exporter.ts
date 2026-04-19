import fs from "node:fs";
import path from "node:path";

import { fetchMessages } from "./db.js";
import { groupMessagesByChatDay, renderMarkdown } from "./formatting.js";
import { ExportOptions, ExportResult } from "./types.js";
import { looksLikeSystemChat, sanitizeFilename } from "./utils.js";

export function exportMarkdown(options: ExportOptions): ExportResult {
  const rawMessages = fetchMessages({
    dbPath: options.dbPath,
    start: options.start,
    end: options.end,
    myName: options.myName,
    includeEmpty: options.includeEmpty,
  });

  const pattern = options.excludeChatRegex ? new RegExp(options.excludeChatRegex) : undefined;
  const filtered = rawMessages.filter((message) => {
    const title = message.chatDisplayName || message.participants.join(", ");
    if (pattern?.test(title || "")) return false;
    if (options.skipSystem && looksLikeSystemChat(title, message.participants)) return false;
    return true;
  });

  const grouped = groupMessagesByChatDay(filtered);
  const outputPaths: string[] = [];

  fs.mkdirSync(options.outputDir, { recursive: true });

  for (const chatDay of grouped) {
    const dayDir = path.join(options.outputDir, chatDay.dateKey);
    fs.mkdirSync(dayDir, { recursive: true });
    const filename = `${sanitizeFilename(chatDay.chatTitle, chatDay.chatKey)}.md`;
    const fullPath = path.join(dayDir, filename);
    fs.writeFileSync(fullPath, renderMarkdown(chatDay), "utf8");
    outputPaths.push(fullPath);
  }

  return {
    filesWritten: outputPaths.length,
    messagesExported: filtered.length,
    outputPaths,
  };
}
