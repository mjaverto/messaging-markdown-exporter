export interface ExportMessage {
  messageId: number;
  timestamp: Date;
  sender: string;
  text: string;
  isFromMe: boolean;
  service?: string | null;
  hadAttachments: boolean;
  chatDisplayName?: string | null;
  participants: string[];
}

export interface ChatDayExport {
  chatKey: string;
  chatTitle: string;
  dateKey: string;
  messages: ExportMessage[];
}

export interface ExportOptions {
  dbPath: string;
  outputDir: string;
  start: Date;
  end: Date;
  myName: string;
  excludeChatRegex?: string;
  skipSystem: boolean;
  includeEmpty: boolean;
}

export interface ExportResult {
  filesWritten: number;
  messagesExported: number;
  outputPaths: string[];
}

export interface InstallOptions {
  outputDir: string;
  scheduleHour: number;
  scheduleMinute: number;
  runQmdEmbed: boolean;
  qmdCommand?: string;
  acPowerOnly: boolean;
  dbPath: string;
  myName: string;
  excludeChatRegex?: string;
  includeSystem: boolean;
  includeEmpty: boolean;
  installDir: string;
}
