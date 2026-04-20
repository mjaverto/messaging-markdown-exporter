/**
 * Canonical list of adapter source identifiers. Kept narrow so the compiler
 * flags typos like "signall" at the call site instead of at runtime.
 */
export const ADAPTER_SOURCES = ["imessage", "telegram", "whatsapp", "signal"] as const;
export type AdapterSource = (typeof ADAPTER_SOURCES)[number];

export function isAdapterSource(value: string): value is AdapterSource {
  return (ADAPTER_SOURCES as readonly string[]).includes(value);
}

export interface NormalizedMessage {
  id: string;
  timestamp: Date;
  sender: string;
  text: string;
  isFromMe: boolean;
  hadAttachments: boolean;
  attachments?: NormalizedAttachment[];
  metadata?: Record<string, string | number | boolean | null>;
}

export interface NormalizedAttachment {
  name?: string;
  path?: string;
  mimeType?: string;
  kind?: "image" | "video" | "audio" | "document" | "other";
}

export interface NormalizedConversation {
  source: AdapterSource;
  conversationId: string;
  title: string;
  participants: string[];
  messages: NormalizedMessage[];
  /**
   * Stable per-source chat identifier (e.g. iMessage chat ROWID). Optional
   * because not every adapter exposes one.
   */
  chatId?: number | string | null;
  /** Underlying transport label (e.g. "iMessage", "SMS"). */
  service?: string | null;
}

export interface ExportAdapter {
  source: AdapterSource;
  loadConversations(options: Record<string, unknown>): Promise<NormalizedConversation[]>;
}

/**
 * Transient adapter failure: the source is momentarily unreachable but the
 * condition is expected to clear on its own (DB lock held by the app that
 * owns it, network blip, etc.). CLI exits with code 75 (EX_TEMPFAIL); the
 * launchd runner should log and continue, NOT flag the overall run as
 * permanently broken.
 */
export class TransientAdapterError extends Error {
  readonly source: string;
  constructor(message: string, source: string) {
    super(message);
    this.name = "TransientAdapterError";
    this.source = source;
  }
}

/**
 * Permanent adapter failure: user intervention required (expired
 * credentials, deleted database, revoked auth). CLI exits with code 78
 * (EX_CONFIG); the launchd runner should surface a macOS notification so
 * the user sees the archive has stopped updating instead of only finding
 * out weeks later when they look at their notes.
 */
export class PermanentAdapterError extends Error {
  readonly source: string;
  constructor(message: string, source: string) {
    super(message);
    this.name = "PermanentAdapterError";
    this.source = source;
  }
}

export const EXIT_TRANSIENT = 75;
export const EXIT_PERMANENT = 78;

/**
 * Frontmatter shape written at the top of every generated markdown file.
 * Optional fields are omitted from the YAML when not applicable
 * (e.g. `contact` only appears for 1:1 chats).
 */
export interface ChatFrontmatter {
  contact?: string;
  participants?: string[];
  handles: string[];
  chatId?: number | string | null;
  service?: string | null;
  source: AdapterSource;
  messageCount: number;
  firstMessage: string;
  lastMessage: string;
  exportedAt: string;
  /**
   * Emitted only when contacts resolution was attempted but yielded an
   * empty map (both AddressBook SQLite and JXA paths failed). Downstream
   * tooling can use this to flag exports where raw handles render in
   * place of names instead of silently treating phone numbers as canonical.
   */
  contactsResolved?: boolean;
}
