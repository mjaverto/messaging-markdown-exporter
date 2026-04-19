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
  source: string;
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
  source: string;
  loadConversations(options: Record<string, unknown>): Promise<NormalizedConversation[]>;
}

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
  source: string;
  messageCount: number;
  firstMessage: string;
  lastMessage: string;
  exportedAt: string;
}
