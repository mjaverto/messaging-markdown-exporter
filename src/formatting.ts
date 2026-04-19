import { ChatDayExport, ExportMessage } from "./types.js";
import { slugForChat } from "./utils.js";

export function groupMessagesByChatDay(messages: ExportMessage[]): ChatDayExport[] {
  const grouped = new Map<string, ExportMessage[]>();
  const titles = new Map<string, string>();

  for (const message of [...messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())) {
    const chatTitle = message.chatDisplayName || message.participants.join(", ") || "Unknown Chat";
    const chatKey = slugForChat(message.chatDisplayName, message.participants, `chat-${message.messageId}`);
    const dateKey = message.timestamp.toISOString().slice(0, 10);
    const key = `${chatKey}::${dateKey}`;
    const list = grouped.get(key) || [];
    list.push(message);
    grouped.set(key, list);
    titles.set(chatKey, chatTitle);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, msgs]) => {
      const [chatKey, dateKey] = key.split("::");
      return {
        chatKey,
        chatTitle: titles.get(chatKey) || chatKey,
        dateKey,
        messages: msgs,
      };
    });
}

export function renderMessageLine(message: ExportMessage): string {
  const hh = String(message.timestamp.getHours()).padStart(2, "0");
  const mm = String(message.timestamp.getMinutes()).padStart(2, "0");
  const sender = message.sender.trim() || (message.isFromMe ? "Me" : "Unknown");
  const text = message.text.trim() || "[no text]";
  const attachmentNote = message.hadAttachments ? " [attachments omitted]" : "";
  return `- ${hh}:${mm} ${sender}: ${text}${attachmentNote}`;
}

export function renderMarkdown(chatDay: ChatDayExport, generatedAt = new Date()): string {
  const lines = [
    `# ${chatDay.chatTitle}`,
    `Date: ${chatDay.dateKey}`,
    `Generated: ${generatedAt.toISOString()}`,
    "",
    ...chatDay.messages.map(renderMessageLine),
    "",
  ];
  return lines.join("\n");
}
