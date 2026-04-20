export const CONFIG_VERSION = 1;

export interface AppConfig {
  version: number;
  source: string;
  /**
   * When set, the runner template iterates over each entry instead of just
   * `source`. Lets a single launchd job export multiple sources back-to-back
   * (iMessage + Signal + WhatsApp + Telegram). Older single-source configs
   * remain valid.
   */
  enabledSources?: string[];
  outputDir: string;
  exportPath?: string;
  /** Optional explicit DB path for the Signal adapter. */
  signalDbPath?: string;
  /** Optional explicit DB path for the WhatsApp adapter. */
  whatsappDbPath?: string;
  scheduleHour: number;
  scheduleMinute: number;
  runQmdEmbed: boolean;
  qmdCommand?: string;
  acPowerOnly: boolean;
  dbPath: string;
  myName: string;
  includeEmpty: boolean;
  installDir: string;
  repoDir: string;
}

export function validateSchedule(value: string): { hour: number; minute: number } {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid schedule '${value}'. Use HH:MM in 24-hour time.`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid schedule '${value}'. Hour must be 00-23 and minute 00-59.`);
  }
  return { hour, minute };
}
