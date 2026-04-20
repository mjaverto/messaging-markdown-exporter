import path from "node:path";

const INVALID_FILENAME_RE = /[^A-Za-z0-9._ -]+/g;
const WHITESPACE_RE = /\s+/g;
const SYSTEM_CHAT_RE =
  /(verification code|otp|2fa|do not reply|no-reply|automated|alert|notification)/i;

export function sanitizeFilename(value: string, fallback = "chat"): string {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const cleaned = normalized
    .trim()
    .replaceAll("/", "-")
    .replace(INVALID_FILENAME_RE, "")
    .replace(WHITESPACE_RE, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "");
  return cleaned.slice(0, 120) || fallback;
}

export function looksLikeSystemChat(
  name: string | null | undefined,
  participants: string[],
): boolean {
  return SYSTEM_CHAT_RE.test([name, ...participants].filter(Boolean).join(" "));
}

export function slugForChat(
  name: string | null | undefined,
  participants: string[],
  fallback: string,
): string {
  if (name) return sanitizeFilename(name, fallback);
  if (participants.length > 0) return sanitizeFilename(participants.sort().join(", "), fallback);
  return fallback;
}

export function expandHome(input: string): string {
  if (input === "~") return process.env.HOME || input;
  if (input.startsWith("~/")) return path.join(process.env.HOME || "", input.slice(2));
  return input;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
