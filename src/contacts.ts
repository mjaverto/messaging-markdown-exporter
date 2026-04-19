import { execFileSync } from "node:child_process";

/**
 * Map from a normalized handle (phone-last-10 or lowercased email) to a
 * human-readable contact display name.
 */
export type ContactsMap = Map<string, string>;

let cached: ContactsMap | null = null;
let cacheKey: string | null = null;

/**
 * Normalize a handle for map lookup.
 *
 * - Phone numbers: strip everything but digits, keep the last 10 (US-centric).
 *   This trades off international correctness for the common case where the
 *   chat handle is E.164 (`+15705551234`) and the contact card stores the
 *   number in any of half a dozen formats.
 * - Emails: lowercase + trim.
 *
 * Anything that does not look like an email and contains no digits is
 * returned trimmed/lowercased as a last resort.
 */
export function normalizeHandle(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const digits = trimmed.replace(/\D+/g, "");
  if (digits.length === 0) return trimmed.toLowerCase();
  return digits.slice(-10);
}

/**
 * JXA script: dump all Contacts as a flat array of
 * `{ name, phones: string[], emails: string[] }` and print as JSON.
 *
 * Kept tiny and defensive — Contacts.app sometimes returns null/undefined
 * for missing fields. We coerce to strings and filter falsy values.
 */
const JXA_SCRIPT = `
ObjC.import('stdlib');
const Contacts = Application('Contacts');
const people = Contacts.people();
const out = [];
for (let i = 0; i < people.length; i++) {
  const p = people[i];
  let name = '';
  try { name = p.name() || ''; } catch (e) { name = ''; }
  if (!name) {
    try {
      const first = p.firstName() || '';
      const last = p.lastName() || '';
      name = (first + ' ' + last).trim();
    } catch (e) { /* ignore */ }
  }
  if (!name) {
    try { name = p.organization() || ''; } catch (e) { /* ignore */ }
  }
  if (!name) continue;

  const phones = [];
  try {
    const pp = p.phones();
    for (let j = 0; j < pp.length; j++) {
      const v = pp[j].value();
      if (v) phones.push(String(v));
    }
  } catch (e) { /* ignore */ }

  const emails = [];
  try {
    const ee = p.emails();
    for (let j = 0; j < ee.length; j++) {
      const v = ee[j].value();
      if (v) emails.push(String(v));
    }
  } catch (e) { /* ignore */ }

  out.push({ name: name, phones: phones, emails: emails });
}
JSON.stringify(out);
`;

interface RawContact {
  name: string;
  phones: string[];
  emails: string[];
}

/**
 * Dump the macOS Contacts database via JXA into a normalized lookup map.
 *
 * The first run will trigger a Contacts permission prompt for whichever
 * binary is invoking `osascript` (the parent terminal app, or the launchd
 * spawning process). If access is denied or any error occurs the function
 * logs a warning to stderr and returns an empty map — callers are expected
 * to fall back to the raw handle.
 *
 * The result is cached for the lifetime of the process keyed on the
 * timeout knob so repeat calls during the same export are free.
 */
export async function loadContactsMap(options: { timeoutMs?: number } = {}): Promise<ContactsMap> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const key = `t=${timeoutMs}`;
  if (cached && cacheKey === key) return cached;

  const map: ContactsMap = new Map();
  try {
    const stdout = execFileSync("osascript", ["-l", "JavaScript", "-e", JXA_SCRIPT], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    const records = JSON.parse(stdout) as RawContact[];
    for (const record of records) {
      const name = (record.name || "").trim();
      if (!name) continue;
      for (const phone of record.phones || []) {
        const k = normalizeHandle(phone);
        if (k && !map.has(k)) map.set(k, name);
      }
      for (const email of record.emails || []) {
        const k = normalizeHandle(email);
        if (k && !map.has(k)) map.set(k, name);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[contacts] Could not read Contacts.app via JXA (${message}). Falling back to raw handles.`);
  }

  cached = map;
  cacheKey = key;
  return map;
}

/**
 * Resolve a single chat handle to a display name, or return the handle
 * unchanged if the contact is unknown.
 */
export function resolveHandle(handle: string, contacts: ContactsMap): string {
  if (!handle) return handle;
  const key = normalizeHandle(handle);
  return contacts.get(key) || handle;
}

/** Test-only: clear the in-process cache. */
export function _resetContactsCacheForTests(): void {
  cached = null;
  cacheKey = null;
}
