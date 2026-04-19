import { ContactsMap, resolveHandle } from "../contacts.js";
import { ChatFrontmatter, NormalizedConversation, NormalizedMessage } from "./model.js";
import { sanitizeFilename } from "../utils.js";

export interface RenderedFile {
  relativePath: string;
  content: string;
}

export interface RenderOptions {
  contacts?: ContactsMap;
  useContactNames?: boolean;
  exportedAt?: Date;
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function renderLine(message: NormalizedMessage): string {
  const hh = String(message.timestamp.getHours()).padStart(2, "0");
  const mm = String(message.timestamp.getMinutes()).padStart(2, "0");
  const text = message.text.trim() || "[no text]";
  const attachmentSummary = message.attachments?.length
    ? ` [${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"} omitted]`
    : message.hadAttachments ? " [attachments omitted]" : "";
  return `- ${hh}:${mm} ${message.sender}: ${text}${attachmentSummary}`;
}

/**
 * Quote a single YAML scalar. We deliberately keep the YAML emitter local
 * and tiny — pulling in `js-yaml` for ~10 fields would be overkill. The
 * only chars we worry about for our values (names, handles, ISO times,
 * integers) are double quotes and backslashes.
 */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlList(values: string[]): string {
  return `[${values.map(yamlString).join(", ")}]`;
}

export function renderFrontmatter(frontmatter: ChatFrontmatter): string {
  const lines: string[] = ["---"];
  if (frontmatter.contact) lines.push(`contact: ${yamlString(frontmatter.contact)}`);
  if (frontmatter.participants && frontmatter.participants.length > 0) {
    lines.push(`participants: ${yamlList(frontmatter.participants)}`);
  }
  lines.push(`handles: ${yamlList(frontmatter.handles)}`);
  if (frontmatter.chatId != null) {
    lines.push(`chat_id: ${typeof frontmatter.chatId === "number" ? frontmatter.chatId : yamlString(String(frontmatter.chatId))}`);
  }
  if (frontmatter.service) lines.push(`service: ${yamlString(frontmatter.service)}`);
  lines.push(`source: ${yamlString(frontmatter.source)}`);
  lines.push(`message_count: ${frontmatter.messageCount}`);
  lines.push(`first_message: ${frontmatter.firstMessage}`);
  lines.push(`last_message: ${frontmatter.lastMessage}`);
  lines.push(`exported_at: ${frontmatter.exportedAt}`);
  lines.push("---");
  return lines.join("\n");
}

/**
 * Build the per-day frontmatter block for a conversation slice.
 *
 * For 1:1 chats (single non-self handle) we emit `contact:` and skip
 * `participants:`. For group chats we emit `participants:` (resolved
 * names where possible) plus the raw `handles:` array.
 */
function buildFrontmatter(
  conversation: NormalizedConversation,
  daySorted: NormalizedMessage[],
  options: RenderOptions,
  exportedAt: Date,
): ChatFrontmatter {
  const contacts = options.contacts;
  const handles = [...conversation.participants];
  const resolvedParticipants = contacts
    ? handles.map((handle) => resolveHandle(handle, contacts))
    : [...handles];
  const isOneOnOne = handles.length === 1;
  const first = daySorted[0]!;
  const last = daySorted[daySorted.length - 1]!;

  const frontmatter: ChatFrontmatter = {
    handles,
    chatId: conversation.chatId ?? null,
    service: conversation.service ?? null,
    source: conversation.source,
    messageCount: daySorted.length,
    firstMessage: first.timestamp.toISOString(),
    lastMessage: last.timestamp.toISOString(),
    exportedAt: exportedAt.toISOString(),
  };

  if (isOneOnOne) {
    frontmatter.contact = resolvedParticipants[0] || handles[0] || conversation.title;
  } else if (resolvedParticipants.length > 0) {
    frontmatter.participants = resolvedParticipants;
  }

  return frontmatter;
}

/**
 * Pick the on-disk filename stem for a conversation-day export.
 *
 * Default behavior (backward compatible): use the existing slug derived
 * from the conversation title or id, so installed runners keep producing
 * the same filenames.
 *
 * When `useContactNames` is enabled, prefer the resolved contact name for
 * 1:1 chats. Group chats keep their existing slug-based name, since
 * arbitrary participant lists can produce filenames that vary day-to-day.
 */
function chooseFilename(
  conversation: NormalizedConversation,
  fallbackStem: string,
  options: RenderOptions,
): string {
  if (!options.useContactNames || !options.contacts) return fallbackStem;
  if (conversation.participants.length !== 1) return fallbackStem;
  const resolved = resolveHandle(conversation.participants[0]!, options.contacts);
  return sanitizeFilename(resolved, fallbackStem);
}

export function renderConversationDays(
  conversation: NormalizedConversation,
  options: RenderOptions = {},
): RenderedFile[] {
  const exportedAt = options.exportedAt ?? new Date();
  const contacts = options.contacts;

  // Resolve the conversation title up front so the markdown header reads
  // as a name rather than a phone number when we have a contacts hit.
  const resolvedTitle = (() => {
    if (!contacts) return conversation.title;
    if (conversation.participants.length === 1) {
      return resolveHandle(conversation.participants[0]!, contacts);
    }
    if (conversation.participants.length > 0) {
      return conversation.participants.map((handle) => resolveHandle(handle, contacts)).join(", ");
    }
    return conversation.title;
  })();

  const buckets = new Map<string, NormalizedMessage[]>();
  const sorted = [...conversation.messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  for (const message of sorted) {
    // Resolve incoming sender to a contact name when possible.
    if (contacts && !message.isFromMe) {
      const candidate = resolveHandle(message.sender, contacts);
      if (candidate !== message.sender) message.sender = candidate;
    }
    const key = dateKey(message.timestamp);
    const list = buckets.get(key) || [];
    list.push(message);
    buckets.set(key, list);
  }

  const fallbackStem = sanitizeFilename(conversation.title || conversation.conversationId, conversation.conversationId);
  const filenameStem = chooseFilename(conversation, fallbackStem, options);

  // For the human-readable header we want to show a Participants: line
  // whenever the conversation has any handles, regardless of whether the
  // frontmatter chose `contact:` (1:1) or `participants:` (group). Resolve
  // through the contacts map when present so the line reads as names.
  const headerParticipants = contacts
    ? conversation.participants.map((handle) => resolveHandle(handle, contacts))
    : [...conversation.participants];

  return [...buckets.entries()].map(([key, messages]) => {
    const frontmatter = buildFrontmatter(conversation, messages, options, exportedAt);
    const lines = [
      renderFrontmatter(frontmatter),
      "",
      `# ${resolvedTitle}`,
      `Source: ${conversation.source}`,
      `Date: ${key}`,
      headerParticipants.length
        ? `Participants: ${headerParticipants.join(", ")}`
        : undefined,
      "",
      ...messages.map(renderLine),
      "",
    ].filter((line): line is string => typeof line === "string");
    return {
      relativePath: `${conversation.source}/${key}/${filenameStem}.md`,
      content: lines.join("\n"),
    };
  });
}
