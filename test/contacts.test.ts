import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  _resetContactsCacheForTests,
  loadFromAddressBookSQLite,
  normalizeHandle,
} from "../src/contacts.js";

const nativeRequire = createRequire(import.meta.url);

describe("normalizeHandle", () => {
  test("strips formatting from US phone numbers", () => {
    expect(normalizeHandle("+1 (570) 241-6510")).toBe("5702416510");
    expect(normalizeHandle("+15702416510")).toBe("5702416510");
    expect(normalizeHandle("570-241-6510")).toBe("5702416510");
    expect(normalizeHandle("570.241.6510")).toBe("5702416510");
  });

  test("lowercases and trims emails", () => {
    expect(normalizeHandle("  Mike@Example.COM  ")).toBe("mike@example.com");
  });

  test("handles empty input", () => {
    expect(normalizeHandle("")).toBe("");
  });
});

/**
 * Build a synthetic AddressBook Sources tree with a tiny .abcddb file
 * pre-populated using better-sqlite3-multiple-ciphers directly. The
 * generated schemas mirror the real macOS AddressBook-v22 tables for the
 * columns our reader touches -- every other column is skipped.
 */
type FixtureContact = {
  firstName?: string | null;
  lastName?: string | null;
  nickname?: string | null;
  organization?: string | null;
  phones?: string[];
  emails?: string[];
};

function buildAbcddbSource(dbPath: string, contacts: FixtureContact[]): void {
  type DatabaseCtor = new (filename: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
    close: () => void;
  };
  const Database = nativeRequire("better-sqlite3-multiple-ciphers") as DatabaseCtor;
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE ZABCDRECORD (
      Z_PK INTEGER PRIMARY KEY,
      ZFIRSTNAME VARCHAR,
      ZLASTNAME VARCHAR,
      ZNICKNAME VARCHAR,
      ZORGANIZATION VARCHAR
    );
    CREATE TABLE ZABCDPHONENUMBER (
      Z_PK INTEGER PRIMARY KEY,
      ZOWNER INTEGER,
      ZFULLNUMBER VARCHAR
    );
    CREATE TABLE ZABCDEMAILADDRESS (
      Z_PK INTEGER PRIMARY KEY,
      ZOWNER INTEGER,
      ZADDRESS VARCHAR
    );
  `);
  const insertRec = db.prepare(
    "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZNICKNAME, ZORGANIZATION) VALUES (?, ?, ?, ?, ?)",
  );
  const insertPhone = db.prepare(
    "INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?, ?)",
  );
  const insertEmail = db.prepare(
    "INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS) VALUES (?, ?)",
  );
  contacts.forEach((contact, index) => {
    const pk = index + 1;
    insertRec.run(
      pk,
      contact.firstName ?? null,
      contact.lastName ?? null,
      contact.nickname ?? null,
      contact.organization ?? null,
    );
    for (const phone of contact.phones ?? []) insertPhone.run(pk, phone);
    for (const email of contact.emails ?? []) insertEmail.run(pk, email);
  });
  db.close();
}

describe("loadFromAddressBookSQLite", () => {
  let tmpRoot: string;

  beforeEach(() => {
    _resetContactsCacheForTests();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contacts-fixture-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeSource(sourceName: string, contacts: FixtureContact[]): void {
    const dir = path.join(tmpRoot, sourceName);
    fs.mkdirSync(dir, { recursive: true });
    buildAbcddbSource(path.join(dir, "AddressBook-v22.abcddb"), contacts);
  }

  test("returns null when the sources dir does not exist", () => {
    const result = loadFromAddressBookSQLite({ sourcesDir: path.join(tmpRoot, "nope") });
    expect(result).toBeNull();
  });

  test("reads contacts from a single source and normalizes handles", () => {
    makeSource("A-UUID", [
      { firstName: "Tim", lastName: "Sharpe", phones: ["(912) 531-5244"], emails: ["Tim@Example.COM"] },
      { firstName: "Dan", lastName: "Pohlig", phones: ["+1 570-555-1234"] },
      { organization: "Plains Vet Hospital", phones: ["5701234567"] },
      // Unnamed/empty record should be skipped.
      { phones: ["9999999999"] },
    ]);

    const result = loadFromAddressBookSQLite({ sourcesDir: tmpRoot });
    expect(result).not.toBeNull();
    expect(result!.sourceCount).toBe(1);
    expect(result!.map.get("9125315244")).toBe("Tim Sharpe");
    expect(result!.map.get("tim@example.com")).toBe("Tim Sharpe");
    expect(result!.map.get("5705551234")).toBe("Dan Pohlig");
    expect(result!.map.get("5701234567")).toBe("Plains Vet Hospital");
    expect(result!.map.has("9999999999")).toBe(false);
  });

  test("merges multiple sources deterministically (first writer wins, alphabetical source order)", () => {
    // 'A-source' is read first (alphabetical), so its value wins on conflicts.
    makeSource("A-source", [
      { firstName: "Alice", lastName: "Anderson", phones: ["+15705550001"] },
    ]);
    makeSource("B-source", [
      // Conflicts with Alice on the same number -- should NOT overwrite.
      { firstName: "Alice", lastName: "Different-Lastname", phones: ["+15705550001"] },
      { firstName: "Bob", lastName: "Builder", emails: ["bob@example.com"] },
    ]);

    const result = loadFromAddressBookSQLite({ sourcesDir: tmpRoot });
    expect(result).not.toBeNull();
    expect(result!.sourceCount).toBe(2);
    expect(result!.map.get("5705550001")).toBe("Alice Anderson");
    expect(result!.map.get("bob@example.com")).toBe("Bob Builder");
  });

  test("falls back through firstname/lastname -> nickname -> organization", () => {
    makeSource("A", [
      { nickname: "Nick-only", phones: ["+15705550011"] },
      { organization: "Org-only Inc", emails: ["contact@org-only.example"] },
      { firstName: "First", phones: ["+15705550012"] },
      { lastName: "Last", phones: ["+15705550013"] },
    ]);

    const result = loadFromAddressBookSQLite({ sourcesDir: tmpRoot });
    expect(result).not.toBeNull();
    expect(result!.map.get("5705550011")).toBe("Nick-only");
    expect(result!.map.get("contact@org-only.example")).toBe("Org-only Inc");
    expect(result!.map.get("5705550012")).toBe("First");
    expect(result!.map.get("5705550013")).toBe("Last");
  });

  test("returns null when no .abcddb files exist under any source", () => {
    fs.mkdirSync(path.join(tmpRoot, "empty-source"), { recursive: true });
    const result = loadFromAddressBookSQLite({ sourcesDir: tmpRoot });
    expect(result).toBeNull();
  });
});
