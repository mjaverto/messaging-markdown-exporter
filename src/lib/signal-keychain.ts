import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

/**
 * Chromium / Electron safeStorage parameters used by Signal Desktop on macOS.
 * Signal wraps its SQLCipher DB key via Electron's safeStorage, which on macOS
 * derives an AES-128-CBC key from a Keychain-stored password using
 * PBKDF2-HMAC-SHA1 with salt "saltysalt" and 1003 iterations, and uses 16
 * space bytes (0x20) as the IV. This scheme is inherited from Chromium OSCrypt.
 */
const SAFE_STORAGE_SALT = "saltysalt";
const SAFE_STORAGE_ITERATIONS = 1003;
const SAFE_STORAGE_KEYLEN = 16;
const SAFE_STORAGE_IV = Buffer.alloc(16, 0x20);
const SAFE_STORAGE_MAGIC_V10 = "v10";
const SAFE_STORAGE_MAGIC_V11 = "v11";

export interface SignalConfigJson {
  /** Hex-encoded safeStorage-wrapped SQLCipher key (modern Signal). */
  encryptedKey?: string;
  /** Legacy plaintext hex SQLCipher key (pre-safeStorage Signal builds). */
  key?: string;
}

export interface ResolvedSignalKey {
  /** Raw SQLCipher hex key suitable for `PRAGMA key = "x'<hex>'"`. */
  hexKey: string;
  /** Which path produced the key (useful for diagnostics / tests). */
  source: "legacy-plaintext" | "safe-storage";
}

export class SignalKeyError extends Error {
  constructor(
    message: string,
    readonly code: "keychain-missing" | "config-missing" | "config-invalid" | "decrypt-failed",
  ) {
    super(message);
    this.name = "SignalKeyError";
  }
}

/**
 * Derive the AES-128 wrapping key from a Keychain-stored safeStorage password
 * using the Chromium OSCrypt parameters. Exposed for unit testing against
 * known vectors.
 */
export function deriveSafeStorageKey(keychainPassword: string): Buffer {
  return crypto.pbkdf2Sync(
    keychainPassword,
    SAFE_STORAGE_SALT,
    SAFE_STORAGE_ITERATIONS,
    SAFE_STORAGE_KEYLEN,
    "sha1",
  );
}

/**
 * Decrypt an `encryptedKey` field (hex-encoded, with "v10"/"v11" prefix) using
 * a Keychain-stored safeStorage password. Returns the decrypted DB key as a
 * UTF-8 string (Signal stores it as 64 hex characters).
 */
export function decryptEncryptedKey(encryptedKeyHex: string, keychainPassword: string): string {
  const bytes = Buffer.from(encryptedKeyHex, "hex");
  if (bytes.length <= 3) {
    throw new SignalKeyError("encryptedKey too short to contain magic prefix", "config-invalid");
  }
  const magic = bytes.subarray(0, 3).toString("ascii");
  if (magic !== SAFE_STORAGE_MAGIC_V10 && magic !== SAFE_STORAGE_MAGIC_V11) {
    throw new SignalKeyError(
      `Unexpected safeStorage magic prefix: ${JSON.stringify(magic)}`,
      "config-invalid",
    );
  }
  const ciphertext = bytes.subarray(3);
  const derived = deriveSafeStorageKey(keychainPassword);
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", derived, SAFE_STORAGE_IV);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch (error) {
    throw new SignalKeyError(
      `Failed to decrypt Signal encryptedKey — keychain password likely wrong (${(error as Error).message})`,
      "decrypt-failed",
    );
  }
}

/**
 * Run `security find-generic-password` to fetch the Electron safeStorage
 * password Signal stashed in the macOS Keychain. Returns the raw password
 * string (Electron stores base64-encoded random bytes).
 *
 * Signal's keychain account name has varied across versions — current
 * builds use "Signal Key", older builds used "Signal". Try both before
 * giving up so users on either era work without manual config.
 */
export function readKeychainPassword(
  service = "Signal Safe Storage",
  accounts: readonly string[] = ["Signal Key", "Signal"],
): string {
  const errors: string[] = [];
  for (const account of accounts) {
    try {
      const out = execFileSync(
        "security",
        ["find-generic-password", "-w", "-s", service, "-a", account],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return out.replace(/\r?\n$/, "");
    } catch (error) {
      errors.push(`account="${account}": ${(error as Error).message}`);
    }
  }
  throw new SignalKeyError(
    `Could not read Signal safeStorage password from macOS Keychain (service="${service}"). ` +
      `Tried accounts: ${accounts.map((a) => `"${a}"`).join(", ")}. ` +
      `Errors: ${errors.join(" | ")}`,
    "keychain-missing",
  );
}

function readSignalConfig(configPath: string): SignalConfigJson {
  if (!fs.existsSync(configPath)) {
    throw new SignalKeyError(`Signal config.json not found at ${configPath}`, "config-missing");
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as SignalConfigJson;
  } catch (error) {
    throw new SignalKeyError(
      `Signal config.json at ${configPath} is not valid JSON: ${(error as Error).message}`,
      "config-invalid",
    );
  }
}

/**
 * Resolve the SQLCipher key for a Signal Desktop install. Prefers the modern
 * safeStorage-wrapped `encryptedKey`, falling back to the legacy plaintext
 * `key` field for older Signal builds. Callers get a hex string ready to pass
 * to `PRAGMA key = "x'<hex>'"`.
 */
export function resolveSignalKey(configPath: string): ResolvedSignalKey {
  const config = readSignalConfig(configPath);
  if (config.encryptedKey) {
    const password = readKeychainPassword();
    const hexKey = decryptEncryptedKey(config.encryptedKey, password);
    if (!/^[0-9a-fA-F]{64,128}$/.test(hexKey)) {
      throw new SignalKeyError(
        "Decrypted Signal key is not hex — aborting to avoid corrupting DB open",
        "decrypt-failed",
      );
    }
    return { hexKey, source: "safe-storage" };
  }
  if (config.key) {
    if (!/^[0-9a-fA-F]{64,128}$/.test(config.key)) {
      throw new SignalKeyError("Legacy Signal key field is not hex", "config-invalid");
    }
    return { hexKey: config.key, source: "legacy-plaintext" };
  }
  throw new SignalKeyError(
    `Signal config.json at ${configPath} has neither "encryptedKey" nor "key"`,
    "config-invalid",
  );
}
