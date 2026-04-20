#!/usr/bin/env tsx
/**
 * Generates small synthetic SQLite fixture databases for test/e2e testing.
 *
 * Fixtures are hermetic — no real user data, no system dependencies.
 *
 * Outputs:
 *   test/fixtures/imessage.chat.db
 *   test/fixtures/whatsapp.ChatStorage.sqlite
 *   test/fixtures/signal.db   (plaintext key via legacy config.json "key" field)
 *   test/fixtures/signal-config.json (config.json pointing to the plain key)
 *
 * Signal notes:
 *   We bypass SQLCipher entirely by using the legacy "key" field in
 *   config.json so the fixture can be opened in CI without macOS Keychain.
 *   The key used is a 64-hex-char zero string:
 *     0000000000000000000000000000000000000000000000000000000000000000
 *   We store this in config.json as { "key": "000...000" } and use
 *   better-sqlite3-multiple-ciphers to write an encrypted DB with that key.
 *
 * Run:
 *   npx tsx test/fixtures/generate.ts
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nativeRequire = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = nativeRequire("better-sqlite3-multiple-ciphers") as any;

const FIXTURES_DIR = __dirname;

// ─── Apple / Mac epoch helpers ───────────────────────────────────────────────
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1, 0, 0, 0);
const MAC_EPOCH_OFFSET_SECONDS = 978_307_200; // seconds from Unix epoch to 2001-01-01

/** Convert JS Date to Apple nanoseconds (iMessage BIGINT date column) */
function toAppleNano(date: Date): bigint {
  return BigInt(Math.floor((date.getTime() - APPLE_EPOCH_MS) * 1_000_000));
}

/** Convert JS Date to CoreData seconds since 2001-01-01 (WhatsApp REAL date) */
function toMacSeconds(date: Date): number {
  return date.getTime() / 1000 - MAC_EPOCH_OFFSET_SECONDS;
}

// ─── iMessage fixture ─────────────────────────────────────────────────────────
function generateImessage(): void {
  const outPath = path.join(FIXTURES_DIR, "imessage.chat.db");
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

  const db = new Database(outPath);
  db.exec(`
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY,
      id    TEXT NOT NULL,
      country TEXT,
      service TEXT
    );
    CREATE TABLE chat (
      ROWID        INTEGER PRIMARY KEY,
      guid         TEXT NOT NULL,
      display_name TEXT
    );
    CREATE TABLE message (
      ROWID            INTEGER PRIMARY KEY,
      date             INTEGER NOT NULL,
      is_from_me       INTEGER NOT NULL DEFAULT 0,
      text             TEXT,
      attributedBody   BLOB,
      handle_id        INTEGER,
      service          TEXT,
      cache_roomnames  TEXT
    );
    CREATE TABLE chat_message_join (
      chat_id    INTEGER,
      message_id INTEGER
    );
    CREATE TABLE chat_handle_join (
      chat_id    INTEGER,
      handle_id  INTEGER
    );
    CREATE TABLE attachment (
      ROWID     INTEGER PRIMARY KEY,
      filename  TEXT,
      mime_type TEXT
    );
    CREATE TABLE message_attachment_join (
      message_id   INTEGER,
      attachment_id INTEGER
    );
  `);

  // Handles: two contacts
  db.prepare("INSERT INTO handle VALUES (1,'+15705551234','us','iMessage')").run();
  db.prepare("INSERT INTO handle VALUES (2,'friend@example.com','us','iMessage')").run();

  // Chat 1: 1:1 with +15705551234
  db.prepare("INSERT INTO chat VALUES (1,'iMessage;-;+15705551234','')").run();
  db.prepare("INSERT INTO chat_handle_join VALUES (1,1)").run();

  // Chat 2: group chat
  db.prepare("INSERT INTO chat VALUES (2,'iMessage;+;group-abc','Family Group')").run();
  db.prepare("INSERT INTO chat_handle_join VALUES (2,1)").run();
  db.prepare("INSERT INTO chat_handle_join VALUES (2,2)").run();

  const t1 = toAppleNano(new Date("2024-06-01T10:00:00Z"));
  const t2 = toAppleNano(new Date("2024-06-01T10:05:00Z"));
  const t3 = toAppleNano(new Date("2024-06-01T10:10:00Z"));
  const t4 = toAppleNano(new Date("2024-06-02T08:00:00Z"));

  // Messages for chat 1
  db.prepare("INSERT INTO message VALUES (1,?,0,'hey there',NULL,1,'iMessage',NULL)").run(t1);
  db.prepare("INSERT INTO message VALUES (2,?,1,'hello back',NULL,NULL,'iMessage',NULL)").run(t2);
  db.prepare("INSERT INTO chat_message_join VALUES (1,1)").run();
  db.prepare("INSERT INTO chat_message_join VALUES (1,2)").run();

  // Messages for chat 2 (group)
  db.prepare("INSERT INTO message VALUES (3,?,0,'group hello',NULL,1,'iMessage',NULL)").run(t3);
  db.prepare("INSERT INTO message VALUES (4,?,1,'group reply',NULL,NULL,'iMessage',NULL)").run(t4);
  db.prepare("INSERT INTO chat_message_join VALUES (2,3)").run();
  db.prepare("INSERT INTO chat_message_join VALUES (2,4)").run();

  // Attachment on message 1
  db.prepare("INSERT INTO attachment VALUES (1,'~/Library/Messages/Attachments/img.jpg','image/jpeg')").run();
  db.prepare("INSERT INTO message_attachment_join VALUES (1,1)").run();

  db.close();
  console.log(`Generated: ${outPath} (${fs.statSync(outPath).size} bytes)`);
}

// ─── WhatsApp fixture ─────────────────────────────────────────────────────────
function generateWhatsapp(): void {
  const outPath = path.join(FIXTURES_DIR, "whatsapp.ChatStorage.sqlite");
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

  const db = new Database(outPath);
  db.exec(`
    CREATE TABLE ZWACHATSESSION (
      Z_PK           INTEGER PRIMARY KEY,
      ZCONTACTJID    TEXT,
      ZPARTNERNAME   TEXT,
      ZSESSIONTYPE   INTEGER DEFAULT 0
    );
    CREATE TABLE ZWAMESSAGE (
      Z_PK          INTEGER PRIMARY KEY,
      ZCHATSESSION  INTEGER,
      ZMESSAGEDATE  REAL,
      ZISFROMME     INTEGER DEFAULT 0,
      ZTEXT         TEXT,
      ZFROMJID      TEXT,
      ZTOJID        TEXT,
      ZPUSHNAME     TEXT,
      ZGROUPMEMBER  INTEGER,
      ZMEDIAITEM    INTEGER,
      ZMESSAGETYPE  INTEGER DEFAULT 0
    );
    CREATE TABLE ZWAGROUPMEMBER (
      Z_PK         INTEGER PRIMARY KEY,
      ZCONTACTNAME TEXT,
      ZFIRSTNAME   TEXT,
      ZMEMBERJID   TEXT
    );
    CREATE TABLE ZWAMEDIAITEM (
      Z_PK            INTEGER PRIMARY KEY,
      ZMEDIALOCALPATH TEXT
    );
    CREATE TABLE ZWAPROFILEPUSHNAME (
      Z_PK      INTEGER PRIMARY KEY,
      ZJID      TEXT,
      ZPUSHNAME TEXT
    );
  `);

  // Chat 1: 1:1
  db.prepare("INSERT INTO ZWACHATSESSION VALUES (1,'15705551234@s.whatsapp.net','Alice',0)").run();
  // Chat 2: group
  db.prepare("INSERT INTO ZWACHATSESSION VALUES (2,'111111111-222222222@g.us','Test Group',1)").run();

  const d1 = toMacSeconds(new Date("2024-06-01T10:00:00Z"));
  const d2 = toMacSeconds(new Date("2024-06-01T10:05:00Z"));
  const d3 = toMacSeconds(new Date("2024-06-01T11:00:00Z"));
  const d4 = toMacSeconds(new Date("2024-06-01T11:05:00Z"));

  // Messages in chat 1
  db.prepare("INSERT INTO ZWAMESSAGE VALUES (1,1,?,0,'hi alice',NULL,'15705551234@s.whatsapp.net','Alice',NULL,NULL,0)").run(d1);
  db.prepare("INSERT INTO ZWAMESSAGE VALUES (2,1,?,1,'hello',NULL,NULL,NULL,NULL,NULL,0)").run(d2);

  // Group member
  db.prepare("INSERT INTO ZWAGROUPMEMBER VALUES (1,'Bob Jones',NULL,'5559991111@s.whatsapp.net')").run();
  // Messages in chat 2
  db.prepare("INSERT INTO ZWAMESSAGE VALUES (3,2,?,0,'group msg',NULL,NULL,NULL,1,NULL,0)").run(d3);
  db.prepare("INSERT INTO ZWAMESSAGE VALUES (4,2,?,1,'reply',NULL,NULL,NULL,NULL,NULL,0)").run(d4);

  // Push names
  db.prepare("INSERT INTO ZWAPROFILEPUSHNAME VALUES (1,'15705551234@s.whatsapp.net','Alice')").run();

  db.close();
  console.log(`Generated: ${outPath} (${fs.statSync(outPath).size} bytes)`);
}

// ─── Signal fixture ───────────────────────────────────────────────────────────
/**
 * Signal's DB is SQLCipher-encrypted. We use a well-known test key
 * (64 hex zeros) so CI can open it without a macOS Keychain.
 *
 * The fixture config.json uses the legacy `key` field (no encryptedKey),
 * so resolveSignalKey() takes the fast path and skips the Keychain lookup.
 */
const SIGNAL_TEST_KEY = "0000000000000000000000000000000000000000000000000000000000000000";

function generateSignal(): void {
  const dbPath = path.join(FIXTURES_DIR, "signal.db");
  const configPath = path.join(FIXTURES_DIR, "signal-config.json");

  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const db = new Database(dbPath);
  // Apply SQLCipher encryption with the test key
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  db.pragma(`key = "x'${SIGNAL_TEST_KEY}'"`);

  db.exec(`
    CREATE TABLE conversations (
      id              TEXT PRIMARY KEY,
      name            TEXT,
      profileFullName TEXT,
      e164            TEXT,
      serviceId       TEXT,
      type            TEXT DEFAULT 'private'
    );
    CREATE TABLE messages (
      id             TEXT PRIMARY KEY,
      conversationId TEXT,
      source         TEXT,
      sent_at        INTEGER,
      received_at    INTEGER,
      body           TEXT,
      type           TEXT,
      hasAttachments INTEGER DEFAULT 0
    );
  `);

  // Conversations
  db.prepare("INSERT INTO conversations VALUES ('conv-1','Alice','Alice Wonderland','+15705551234','uuid-alice','private')").run();
  db.prepare("INSERT INTO conversations VALUES ('conv-2','Work Group',NULL,NULL,'uuid-work','group')").run();

  // Messages
  const t1 = new Date("2024-06-01T10:00:00Z").getTime();
  const t2 = new Date("2024-06-01T10:05:00Z").getTime();
  const t3 = new Date("2024-06-01T11:00:00Z").getTime();

  db.prepare("INSERT INTO messages VALUES ('msg-1','conv-1','+15705551234',?,?,?,?,0)").run(t1, t1, "hey there", "incoming");
  db.prepare("INSERT INTO messages VALUES ('msg-2','conv-1',NULL,?,?,?,?,0)").run(t2, t2, "hello back", "outgoing");
  db.prepare("INSERT INTO messages VALUES ('msg-3','conv-2','+15705551111',?,?,?,?,0)").run(t3, t3, "group message", "incoming");
  // System message that should be filtered out (not incoming/outgoing)
  db.prepare("INSERT INTO messages VALUES ('msg-4','conv-1',NULL,?,?,?,?,0)").run(t3, t3, "call started", "call-history");

  db.close();

  // Write the legacy config.json so resolveSignalKey() uses the plaintext path
  fs.writeFileSync(configPath, JSON.stringify({ key: SIGNAL_TEST_KEY }, null, 2));

  console.log(`Generated: ${dbPath} (${fs.statSync(dbPath).size} bytes)`);
  console.log(`Generated: ${configPath}`);
  console.log(`  Signal test key: ${SIGNAL_TEST_KEY}`);
}

// ─── Run all ──────────────────────────────────────────────────────────────────
generateImessage();
generateWhatsapp();
generateSignal();
console.log("\nAll fixtures generated.");
