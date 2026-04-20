import fs from "node:fs";
import path from "node:path";

import { iMessageAdapter } from "./adapters/imessage.js";
import { signalAdapter } from "./adapters/signal.js";
import { telegramAdapter } from "./adapters/telegram.js";
import { whatsappAdapter } from "./adapters/whatsapp.js";
import { renderConversationDays } from "./core/render.js";
import { ContactsMap, loadContactsMap } from "./contacts.js";
import { ExportAdapter } from "./core/model.js";

const adapters = new Map<string, ExportAdapter>([
  [iMessageAdapter.source, iMessageAdapter],
  [telegramAdapter.source, telegramAdapter],
  [whatsappAdapter.source, whatsappAdapter],
  [signalAdapter.source, signalAdapter],
]);

export async function exportFromSource(
  source: string,
  options: Record<string, unknown>,
): Promise<{ filesWritten: number; outputPaths: string[] }> {
  const adapter = adapters.get(source);
  if (!adapter) throw new Error(`Unknown source: ${source}`);
  const outputDir = String(options.outputDir || "./exports");
  const conversations = await adapter.loadConversations(options);

  // Contacts.app integration: only attempted for the iMessage source (where
  // raw handles are phone numbers / emails), and only when the caller has
  // not explicitly opted out. On non-Mac systems or when access is denied,
  // loadContactsMap logs a warning and returns an empty map -- the export
  // falls back to raw handles in that case.
  const useContacts = options.useContacts !== false;
  const contacts: ContactsMap | undefined =
    useContacts && (source === "imessage" || source === "whatsapp")
      ? await loadContactsMap()
      : undefined;
  const useContactNames = Boolean(options.useContactNames);

  const outputPaths: string[] = [];
  fs.mkdirSync(outputDir, { recursive: true });
  for (const conversation of conversations) {
    for (const rendered of renderConversationDays(conversation, { contacts, useContactNames })) {
      const fullPath = path.join(outputDir, rendered.relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, rendered.content, "utf8");
      outputPaths.push(fullPath);
    }
  }
  return { filesWritten: outputPaths.length, outputPaths };
}
