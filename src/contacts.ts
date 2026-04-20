import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

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
 * Default location of the macOS AddressBook Sources directory. Each
 * subdirectory corresponds to one account (iCloud, On My Mac, Exchange,
 * CardDAV, etc.) and contains its own `AddressBook-v22.abcddb` SQLite file.
 */
function defaultAddressBookSourcesDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "AddressBook", "Sources");
}

function displayNameFromRecord(first: string | null, last: string | null, nickname: string | null, organization: string | null): string {
  const firstTrim = (first || "").trim();
  const lastTrim = (last || "").trim();
  const combined = [firstTrim, lastTrim].filter(Boolean).join(" ").trim();
  if (combined) return combined;
  const nick = (nickname || "").trim();
  if (nick) return nick;
  const org = (organization || "").trim();
  if (org) return org;
  return "";
}

/**
 * Snapshot a `.abcddb` file into a temp dir using SQLite's online backup
 * API so we can read it without contending with the live Contacts.app
 * process.
 *
 * Previously this used `fs.copyFileSync` for the main DB + each `-wal` /
 * `-shm` sidecar separately, which is a TOCTOU race: the main file and
 * its WAL can land at different points in Contacts.app's write cycle and
 * produce a torn snapshot that opens but reads as `SQLITE_CORRUPT`.
 *
 * `db.backup(destPath)` uses SQLite's backup API to produce an atomic,
 * point-in-time snapshot that always represents a consistent state.
 */
async function withReadableAbcddbCopy<T>(
  src: string,
  fn: (safeDbPath: string) => T,
): Promise<T> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "contacts-ab-"));
  const safeDb = path.join(tmpDir, "ab.abcddb");
  try {
    const Database = nativeRequire("better-sqlite3-multiple-ciphers") as AbcdDatabaseCtor;
    const sourceDb = new Database(src, { readonly: true, fileMustExist: true });
    try {
      await sourceDb.backup(safeDb);
    } finally {
      sourceDb.close();
    }
    return fn(safeDb);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Native module loaded via createRequire so tsup leaves it as a runtime
// require in the ESM bundle instead of trying to inline it (which fails
// with "Dynamic require of ... is not supported" for CJS native modules).
const nativeRequire = createRequire(import.meta.url);
type AbcdDatabaseCtor = new (
  filename: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => {
  pragma: (source: string, options?: { simple?: boolean }) => unknown;
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
  };
  backup: (destinationFile: string) => Promise<{ totalPages: number; remainingPages: number }>;
  close: () => void;
};

interface RecordRow {
  Z_PK: number;
  ZFIRSTNAME: string | null;
  ZLASTNAME: string | null;
  ZNICKNAME: string | null;
  ZORGANIZATION: string | null;
}

interface PhoneRow {
  ZOWNER: number | null;
  ZFULLNUMBER: string | null;
}

interface EmailRow {
  ZOWNER: number | null;
  ZADDRESS: string | null;
}

/**
 * Read one `.abcddb` file into a normalized handle -> display-name map.
 *
 * AddressBook schema (v22, macOS 14+):
 * - `ZABCDRECORD`: one row per person. Display name is
 *   `ZFIRSTNAME + " " + ZLASTNAME`, falling back to `ZNICKNAME` or
 *   `ZORGANIZATION` for org-only cards.
 * - `ZABCDPHONENUMBER`: `ZOWNER` (FK -> ZABCDRECORD.Z_PK), `ZFULLNUMBER`.
 * - `ZABCDEMAILADDRESS`: `ZOWNER` (FK), `ZADDRESS`.
 *
 * Normalization matches the JXA path: phones stripped to last 10 digits,
 * emails lowercased + trimmed.
 */
async function loadFromAbcddb(dbPath: string): Promise<ContactsMap> {
  const Database = nativeRequire("better-sqlite3-multiple-ciphers") as AbcdDatabaseCtor;
  const map: ContactsMap = new Map();

  return withReadableAbcddbCopy(dbPath, (safeDbPath) => {
    // AddressBook .abcddb files are plaintext SQLite -- no cipher pragma
    // needed. better-sqlite3-multiple-ciphers auto-detects and opens them
    // fine because their header is not SQLCipher-encrypted.
    const db = new Database(safeDbPath, { readonly: true, fileMustExist: true });

    try {
      const records = db.prepare(
        "SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZNICKNAME, ZORGANIZATION FROM ZABCDRECORD",
      ).all() as RecordRow[];

      const nameByPk = new Map<number, string>();
      for (const r of records) {
        const name = displayNameFromRecord(r.ZFIRSTNAME, r.ZLASTNAME, r.ZNICKNAME, r.ZORGANIZATION);
        if (name) nameByPk.set(r.Z_PK, name);
      }

      const phones = db.prepare(
        "SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL",
      ).all() as PhoneRow[];
      for (const p of phones) {
        if (p.ZOWNER == null || !p.ZFULLNUMBER) continue;
        const name = nameByPk.get(p.ZOWNER);
        if (!name) continue;
        const key = normalizeHandle(p.ZFULLNUMBER);
        if (key && !map.has(key)) map.set(key, name);
      }

      const emails = db.prepare(
        "SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL",
      ).all() as EmailRow[];
      for (const e of emails) {
        if (e.ZOWNER == null || !e.ZADDRESS) continue;
        const name = nameByPk.get(e.ZOWNER);
        if (!name) continue;
        const key = normalizeHandle(e.ZADDRESS);
        if (key && !map.has(key)) map.set(key, name);
      }
    } finally {
      db.close();
    }

    return map;
  });
}

/**
 * Merge a source-level map into the accumulator. First writer wins, which
 * gives a deterministic result when the same handle appears in multiple
 * AddressBook sources (e.g. a number saved both under iCloud and On My Mac).
 */
function mergeContactsMap(target: ContactsMap, source: ContactsMap): void {
  for (const [key, value] of source) {
    if (!target.has(key)) target.set(key, value);
  }
}

/**
 * Read every `AddressBook-v22.abcddb` under `~/Library/Application Support/
 * AddressBook/Sources/<UUID>/` and merge the results.
 *
 * Returns `null` if the sources directory doesn't exist (e.g. Contacts has
 * never been opened on this Mac, or the user keeps contacts elsewhere),
 * which tells the caller to try the JXA fallback.
 */
export async function loadFromAddressBookSQLite(
  options: { sourcesDir?: string } = {},
): Promise<{ map: ContactsMap; sourceCount: number; skippedCount: number; failedSources: string[] } | null> {
  const sourcesDir = options.sourcesDir || defaultAddressBookSourcesDir();
  if (!fs.existsSync(sourcesDir)) return null;

  let entries: string[];
  try {
    entries = fs.readdirSync(sourcesDir);
  } catch {
    return null;
  }

  const dbPaths: string[] = [];
  for (const entry of entries.sort()) {
    const candidate = path.join(sourcesDir, entry, "AddressBook-v22.abcddb");
    if (fs.existsSync(candidate)) dbPaths.push(candidate);
  }
  if (dbPaths.length === 0) return null;

  const merged: ContactsMap = new Map();
  let usedSources = 0;
  const failedSources: string[] = [];
  for (const dbPath of dbPaths) {
    const sourceName = path.basename(path.dirname(dbPath));
    try {
      const perSource = await loadFromAbcddb(dbPath);
      if (perSource.size > 0) {
        mergeContactsMap(merged, perSource);
        usedSources += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[contacts] Skipped AddressBook source ${sourceName}: ${message}`);
      failedSources.push(sourceName);
    }
  }

  // Aggregate visibility: a single summary line so a partially-broken
  // contacts setup (e.g. 5 of 6 sources corrupt) does not masquerade as
  // success when only the per-source warns scroll past in noisy output.
  // ERROR level when nothing loaded -- the downstream JXA fallback may
  // still rescue the export, but the SQLite path itself was a total loss.
  if (failedSources.length > 0) {
    const summary = `${usedSources}/${dbPaths.length} sources loaded, ${failedSources.length} failed: ${failedSources.join(", ")}`;
    if (usedSources === 0) {
      console.error(`[contacts] AddressBook: ${summary}`);
    } else {
      console.warn(`[contacts] AddressBook: ${summary}`);
    }
  }

  return {
    map: merged,
    sourceCount: usedSources,
    skippedCount: failedSources.length,
    failedSources,
  };
}

/**
 * Fallback: dump the macOS Contacts database via JXA into a normalized
 * lookup map.
 *
 * This path requires the Automation -> Contacts grant for whichever
 * binary is invoking `osascript`. Under a launchd-spawned context Apple
 * Events are routinely denied with `-1743` / `ETIMEDOUT`, which is why
 * `loadFromAddressBookSQLite` is tried first and this function is a
 * fallback for non-standard setups (e.g. Contacts data on a network
 * mount the sqlite path can't reach).
 */
export function loadFromJXA(options: { timeoutMs?: number } = {}): ContactsMap {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const map: ContactsMap = new Map();
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
  return map;
}

/**
 * Load the macOS Contacts database into a normalized lookup map, trying
 * the fast SQLite path first and falling back to JXA/osascript on
 * failure.
 *
 * Strategy:
 *   1. Read every `AddressBook-v22.abcddb` under the Sources directory
 *      directly via better-sqlite3-multiple-ciphers. Works under launchd
 *      because it only needs FDA, not the Automation -> Contacts grant.
 *   2. If that yields zero contacts (no sources dir, custom setup,
 *      schema change), fall back to the legacy JXA dump.
 *   3. If JXA also fails (launchd Apple Events denial, Contacts.app not
 *      installed), log a warning and return an empty map. Callers are
 *      expected to fall back to raw handles.
 *
 * The result is cached for the lifetime of the process keyed on the
 * timeout knob so repeat calls during the same export are free.
 */
export async function loadContactsMap(options: { timeoutMs?: number } = {}): Promise<ContactsMap> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const key = `t=${timeoutMs}`;
  if (cached && cacheKey === key) return cached;

  // Step 1: fast, permission-friendly SQLite path.
  try {
    const result = await loadFromAddressBookSQLite();
    if (result && result.map.size > 0) {
      console.log(
        `[contacts] Loaded ${result.map.size} contacts from AddressBook SQLite (${result.sourceCount} sources, ${result.skippedCount} skipped).`,
      );
      cached = result.map;
      cacheKey = key;
      return result.map;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[contacts] AddressBook SQLite read failed (${message}); falling back to JXA.`);
  }

  // Step 2: legacy JXA fallback.
  try {
    const jxaMap = loadFromJXA({ timeoutMs });
    console.log(`[contacts] Loaded ${jxaMap.size} contacts from Contacts.app via JXA (fallback).`);
    cached = jxaMap;
    cacheKey = key;
    return jxaMap;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[contacts] Could not read Contacts.app via JXA (${message}). Falling back to raw handles.`);
  }

  const empty: ContactsMap = new Map();
  cached = empty;
  cacheKey = key;
  return empty;
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
