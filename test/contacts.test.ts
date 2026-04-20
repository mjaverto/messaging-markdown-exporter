import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

  test("returns null when the sources dir does not exist", async () => {
    const result = await loadFromAddressBookSQLite({ sourcesDir: path.join(tmpRoot, "nope") });
    expect(result).toBeNull();
  });

  test("reads contacts from a single source and normalizes handles", async () => {
    makeSource("A-UUID", [
      { firstName: "Tim", lastName: "Sharpe", phones: ["(912) 531-5244"], emails: ["Tim@Example.COM"] },
      { firstName: "Dan", lastName: "Pohlig", phones: ["+1 570-555-1234"] },
      { organization: "Plains Vet Hospital", phones: ["5701234567"] },
      // Unnamed/empty record should be skipped.
      { phones: ["9999999999"] },
    ]);

    const result = await loadFromAddressBookSQLite({ sourcesDir: tmpRoot });
    expect(result).not.toBeNull();
    expect(result!.sourceCount).toBe(1);
    expect(result!.map.get("9125315244")).toBe("Tim Sharpe");
    expect(result!.map.get("tim@example.com")).toBe("Tim Sharpe");
    expect(result!.map.get("5705551234")).toBe("Dan Pohlig");
    expect(result!.map.get("5701234567")).toBe("Plains Vet Hospital");
    expect(result!.map.has("9999999999")).toBe(false);
  });

  test("merges multiple sources deterministically (first writer wins, alphabetical source order)", async () => {
    // 'A-source' is read first (alphabetical), so its value wins on conflicts.
    makeSource("A-source", [
      { firstName: "Alice", lastName: "Anderson", phones: ["+15705550001"] },
    ]);
    makeSource("B-source", [
      // Conflicts with Alice on the same number -- should NOT overwrite.
      { firstName: "Alice", lastName: "Different-Lastname", phones: ["+15705550001"] },
      { firstName: "Bob", lastName: "Builder", emails: ["bob@example.com"] },
    ]);

    const result = await loadFromAddressBookSQLite({ sourcesDir: tmpRoot });
    expect(result).not.toBeNull();
    expect(result!.sourceCount).toBe(2);
    expect(result!.map.get("5705550001")).toBe("Alice Anderson");
    expect(result!.map.get("bob@example.com")).toBe("Bob Builder");
  });

  test("falls back through firstname/lastname -> nickname -> organization", async () => {
    makeSource("A", [
      { nickname: "Nick-only", phones: ["+15705550011"] },
      { organization: "Org-only Inc", emails: ["contact@org-only.example"] },
      { firstName: "First", phones: ["+15705550012"] },
      { lastName: "Last", phones: ["+15705550013"] },
    ]);

    const result = await loadFromAddressBookSQLite({ sourcesDir: tmpRoot });
    expect(result).not.toBeNull();
    expect(result!.map.get("5705550011")).toBe("Nick-only");
    expect(result!.map.get("contact@org-only.example")).toBe("Org-only Inc");
    expect(result!.map.get("5705550012")).toBe("First");
    expect(result!.map.get("5705550013")).toBe("Last");
  });

  test("returns null when no .abcddb files exist under any source", async () => {
    fs.mkdirSync(path.join(tmpRoot, "empty-source"), { recursive: true });
    const result = await loadFromAddressBookSQLite({ sourcesDir: tmpRoot });
    expect(result).toBeNull();
  });

  describe("partial-failure aggregate log + skippedCount", () => {
    function makeCorruptSource(sourceName: string): void {
      const dir = path.join(tmpRoot, sourceName);
      fs.mkdirSync(dir, { recursive: true });
      // Anything that is not a valid SQLite file -- opening it as DB will throw.
      fs.writeFileSync(path.join(dir, "AddressBook-v22.abcddb"), "this is not a sqlite database");
    }

    test("all sources succeed: skippedCount=0, no aggregate log", async () => {
      makeSource("A-good", [
        { firstName: "Tim", phones: ["+15705551111"] },
      ]);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await loadFromAddressBookSQLite({ sourcesDir: tmpRoot });
        expect(result).not.toBeNull();
        expect(result!.sourceCount).toBe(1);
        expect(result!.skippedCount).toBe(0);
        expect(result!.failedSources).toEqual([]);
        const aggregateCalls = warnSpy.mock.calls.filter((args) =>
          String(args[0] ?? "").includes("AddressBook:"),
        );
        expect(aggregateCalls).toHaveLength(0);
        expect(errSpy).not.toHaveBeenCalled();
      } finally {
        errSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    test("some sources fail: warn-level aggregate, correct skippedCount and failedSources", async () => {
      makeSource("A-good", [{ firstName: "Tim", phones: ["+15705551111"] }]);
      makeCorruptSource("B-corrupt");
      makeSource("C-good", [{ firstName: "Sam", phones: ["+15705552222"] }]);

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await loadFromAddressBookSQLite({ sourcesDir: tmpRoot });
        expect(result).not.toBeNull();
        expect(result!.sourceCount).toBe(2);
        expect(result!.skippedCount).toBe(1);
        expect(result!.failedSources).toEqual(["B-corrupt"]);
        expect(errSpy).not.toHaveBeenCalled();
        const aggregate = warnSpy.mock.calls
          .map((args) => String(args[0] ?? ""))
          .find((msg) => msg.includes("AddressBook:"));
        expect(aggregate).toBeDefined();
        expect(aggregate).toContain("2/3 sources loaded");
        expect(aggregate).toContain("1 failed");
        expect(aggregate).toContain("B-corrupt");
      } finally {
        errSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    test("all sources fail: error-level aggregate, sourceCount=0, falls through with map", async () => {
      makeCorruptSource("A-corrupt");
      makeCorruptSource("B-corrupt");

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await loadFromAddressBookSQLite({ sourcesDir: tmpRoot });
        expect(result).not.toBeNull();
        expect(result!.sourceCount).toBe(0);
        expect(result!.skippedCount).toBe(2);
        expect(result!.failedSources).toEqual(["A-corrupt", "B-corrupt"]);
        expect(result!.map.size).toBe(0);
        expect(errSpy).toHaveBeenCalledTimes(1);
        const errMsg = String(errSpy.mock.calls[0]?.[0] ?? "");
        expect(errMsg).toContain("AddressBook:");
        expect(errMsg).toContain("0/2 sources loaded");
        expect(errMsg).toContain("2 failed");
      } finally {
        errSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });
});
