import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

import { execFileSync } from "node:child_process";
import { _resetContactsCacheForTests, loadContactsMap } from "../src/contacts.js";

const nativeRequire = createRequire(import.meta.url);

interface FixtureContact {
  firstName?: string | null;
  lastName?: string | null;
  phones?: string[];
  emails?: string[];
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE ZABCDRECORD (
     Z_PK INTEGER PRIMARY KEY,
     ZFIRSTNAME VARCHAR,
     ZLASTNAME VARCHAR,
     ZNICKNAME VARCHAR,
     ZORGANIZATION VARCHAR
   )`,
  `CREATE TABLE ZABCDPHONENUMBER (
     Z_PK INTEGER PRIMARY KEY,
     ZOWNER INTEGER,
     ZFULLNUMBER VARCHAR
   )`,
  `CREATE TABLE ZABCDEMAILADDRESS (
     Z_PK INTEGER PRIMARY KEY,
     ZOWNER INTEGER,
     ZADDRESS VARCHAR
   )`,
];

function buildAbcddbSource(dbPath: string, contacts: FixtureContact[]): void {
  type DatabaseCtor = new (filename: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
    close: () => void;
  };
  const Database = nativeRequire("better-sqlite3-multiple-ciphers") as DatabaseCtor;
  const db = new Database(dbPath);
  const runSchema = db.exec.bind(db);
  for (const stmt of SCHEMA_STATEMENTS) runSchema(stmt);
  const insertRec = db.prepare(
    "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZNICKNAME, ZORGANIZATION) VALUES (?, ?, ?, ?, ?)",
  );
  const insertPhone = db.prepare(
    "INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?, ?)",
  );
  const insertEmail = db.prepare("INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS) VALUES (?, ?)");
  contacts.forEach((contact, index) => {
    const pk = index + 1;
    insertRec.run(pk, contact.firstName ?? null, contact.lastName ?? null, null, null);
    for (const phone of contact.phones ?? []) insertPhone.run(pk, phone);
    for (const email of contact.emails ?? []) insertEmail.run(pk, email);
  });
  db.close();
}

describe("loadContactsMap fallback chain", () => {
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const mockedExec = vi.mocked(execFileSync);

  beforeEach(() => {
    _resetContactsCacheForTests();
    mockedExec.mockReset();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "contacts-home-"));
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test("SQLite path succeeds: returns SQLite map and JXA is never called", async () => {
    const sourceDir = path.join(
      tmpHome,
      "Library",
      "Application Support",
      "AddressBook",
      "Sources",
      "uuid-A",
    );
    fs.mkdirSync(sourceDir, { recursive: true });
    buildAbcddbSource(path.join(sourceDir, "AddressBook-v22.abcddb"), [
      { firstName: "Tim", lastName: "Sharpe", phones: ["(912) 531-5244"] },
    ]);

    const map = await loadContactsMap();

    expect(map.get("9125315244")).toBe("Tim Sharpe");
    expect(mockedExec).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("SQLite path returns null: falls back to JXA and returns JXA map", async () => {
    // No AddressBook Sources dir under tmpHome -> loadFromAddressBookSQLite returns null silently.
    const jxaPayload = JSON.stringify([
      { name: "Bob Builder", phones: ["+15705550001"], emails: ["bob@example.com"] },
    ]);
    mockedExec.mockImplementation((() => jxaPayload) as unknown as typeof execFileSync);

    const map = await loadContactsMap();

    expect(mockedExec).toHaveBeenCalledTimes(1);
    expect(map.get("5705550001")).toBe("Bob Builder");
    expect(map.get("bob@example.com")).toBe("Bob Builder");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("Both SQLite and JXA fail: returns empty map and emits a single warn log", async () => {
    // No AddressBook Sources dir -> SQLite returns null silently (no warn here).
    mockedExec.mockImplementation(() => {
      throw new Error("Apple Events denied (-1743)");
    });

    const map = await loadContactsMap();

    expect(map.size).toBe(0);
    expect(mockedExec).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstWarnArg = warnSpy.mock.calls[0]?.[0];
    expect(String(firstWarnArg)).toMatch(/JXA|Contacts\.app/);
  });
});
