import fs from "node:fs";
import path from "node:path";

import prompts from "prompts";

import { DEFAULT_TELEGRAM_CONFIG_DIR } from "./adapters/telegram.js";
import { expandHome } from "./utils.js";

export interface TelegramLoginOptions {
  telegramConfigDir?: string;
}

export async function telegramLogin(options: TelegramLoginOptions = {}): Promise<void> {
  const configDir = expandHome(options.telegramConfigDir || DEFAULT_TELEGRAM_CONFIG_DIR);
  fs.mkdirSync(configDir, { recursive: true });

  const credsPath = path.join(configDir, "credentials.json");
  const sessionPath = path.join(configDir, "session.txt");

  const existingCreds = fs.existsSync(credsPath)
    ? (JSON.parse(fs.readFileSync(credsPath, "utf8")) as { apiId?: number; apiHash?: string })
    : {};

  const responses = await prompts(
    [
      {
        type: "number",
        name: "apiId",
        message: "Telegram apiId (from my.telegram.org)",
        initial: existingCreds.apiId,
        validate: (value: number) =>
          Number.isFinite(value) && value > 0 ? true : "Enter a positive integer",
      },
      {
        type: "text",
        name: "apiHash",
        message: "Telegram apiHash",
        initial: existingCreds.apiHash,
        validate: (value: string) =>
          value && value.length >= 16 ? true : "apiHash looks too short",
      },
      {
        type: "text",
        name: "phone",
        message: "Phone number (e.g. +15555551234)",
        validate: (value: string) =>
          /^\+?\d{6,}$/.test(value) ? true : "Enter a phone number in international format",
      },
    ],
    { onCancel: () => process.exit(1) },
  );

  const apiId = Number(responses.apiId);
  const apiHash = String(responses.apiHash);
  const phone = String(responses.phone);

  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => phone,
    phoneCode: async () => {
      const { code } = await prompts(
        { type: "text", name: "code", message: "Enter the login code Telegram sent" },
        { onCancel: () => process.exit(1) },
      );
      return String(code);
    },
    password: async () => {
      const { password } = await prompts(
        { type: "password", name: "password", message: "2FA password (leave blank if none)" },
        { onCancel: () => process.exit(1) },
      );
      return password ? String(password) : "";
    },
    onError: (err) => {
      console.error("Login error:", err.message || err);
    },
  });

  const sessionBlob = String(client.session.save());
  fs.writeFileSync(credsPath, JSON.stringify({ apiId, apiHash }, null, 2), "utf8");
  fs.writeFileSync(sessionPath, sessionBlob, "utf8");
  try {
    fs.chmodSync(sessionPath, 0o600);
    fs.chmodSync(credsPath, 0o600);
  } catch {
    // best-effort on non-POSIX filesystems
  }

  try {
    await client.disconnect();
  } catch {
    // ignore
  }

  console.log(`\n✅ Telegram login complete.`);
  console.log(`   Credentials saved to: ${credsPath}`);
  console.log(`   Session saved to:     ${sessionPath}`);
  console.log(
    `\nNext: run 'imessage-to-markdown --source telegram' (or schedule it) for unattended exports.`,
  );
}
