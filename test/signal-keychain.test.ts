import crypto from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  decryptEncryptedKey,
  deriveSafeStorageKey,
  SignalKeyError,
} from "../src/lib/signal-keychain.js";

/**
 * Chromium OSCrypt / Electron safeStorage parameters. Having a second
 * definition of the algorithm inside the test acts as an independent oracle —
 * if we ever corrupt the constants in the source the test will notice.
 */
const SALT = "saltysalt";
const ITERATIONS = 1003;
const IV = Buffer.alloc(16, 0x20);

function encryptEncryptedKey(plainHexKey: string, keychainPassword: string, magic: "v10" | "v11"): string {
  const derived = crypto.pbkdf2Sync(keychainPassword, SALT, ITERATIONS, 16, "sha1");
  const cipher = crypto.createCipheriv("aes-128-cbc", derived, IV);
  const ciphertext = Buffer.concat([cipher.update(plainHexKey, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from(magic, "ascii"), ciphertext]).toString("hex");
}

describe("deriveSafeStorageKey", () => {
  // Test vector generated from Node's own PBKDF2 implementation for the
  // Chromium OSCrypt parameters (salt="saltysalt", 1003 iterations, SHA-1,
  // 16-byte output). Pinning the output byte-for-byte guards against an
  // accidental parameter change.
  test("matches known PBKDF2-SHA1 vector for password 'peanuts'", () => {
    const derived = deriveSafeStorageKey("peanuts");
    expect(derived.toString("hex")).toBe("d9a09d499b4e1b7461f28e67972c6dbd");
  });

  test("produces a 16-byte AES-128 key regardless of password length", () => {
    expect(deriveSafeStorageKey("").length).toBe(16);
    expect(deriveSafeStorageKey("x".repeat(1024)).length).toBe(16);
  });

  test("different passwords derive different keys", () => {
    expect(deriveSafeStorageKey("alpha")).not.toEqual(deriveSafeStorageKey("beta"));
  });
});

describe("decryptEncryptedKey", () => {
  const password = "base64KeychainPassword==";
  // 64 hex chars — Signal's SQLCipher key is 32 bytes represented as hex text.
  const plainHexKey = "0123456789abcdef".repeat(4);

  test("round-trips a v10 safeStorage payload", () => {
    const encryptedHex = encryptEncryptedKey(plainHexKey, password, "v10");
    expect(decryptEncryptedKey(encryptedHex, password)).toBe(plainHexKey);
  });

  test("round-trips a v11 safeStorage payload", () => {
    const encryptedHex = encryptEncryptedKey(plainHexKey, password, "v11");
    expect(decryptEncryptedKey(encryptedHex, password)).toBe(plainHexKey);
  });

  test("rejects a payload with an unknown magic prefix", () => {
    const bogus = Buffer.concat([Buffer.from("v99", "ascii"), Buffer.alloc(16, 0)]).toString("hex");
    expect(() => decryptEncryptedKey(bogus, password)).toThrowError(SignalKeyError);
  });

  test("rejects a payload shorter than the magic prefix", () => {
    expect(() => decryptEncryptedKey("ab", password)).toThrowError(/too short/);
  });

  test("throws decrypt-failed when the password is wrong", () => {
    const encryptedHex = encryptEncryptedKey(plainHexKey, password, "v10");
    expect(() => decryptEncryptedKey(encryptedHex, "wrong-password")).toThrowError(SignalKeyError);
  });
});
