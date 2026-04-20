# Messaging Markdown Exporter

Export conversations from multiple messaging apps into a shared markdown format.

## Supported sources

All four adapters are native, passive readers — no manual export step.

| Source | Input | One-time setup |
|---|---|---|
| `imessage` | macOS `chat.db` (direct read) | Grant Full Disk Access to the binary running the exporter |
| `telegram` | MTProto via gramjs (persistent session) | `node dist/cli.js telegram-login` |
| `whatsapp` | WhatsApp Desktop `ChatStorage.sqlite` (Group Container, plaintext) | Grant Full Disk Access; quit WhatsApp Desktop briefly on first run |
| `signal` | Signal Desktop `db.sqlite` (SQLCipher, key from macOS Keychain) | Quit Signal Desktop so the DB is unlocked; approve the keychain prompt on first run |

## Architecture

The repo is structured around three layers:

1. **Adapters**
   - one per source system
   - convert source-specific exports or databases into a normalized model

2. **Normalized model**
   - shared conversation/message representation
   - keeps rendering independent from source-specific parsing

3. **Renderer**
   - one shared markdown renderer
   - creates daily markdown files in a consistent layout

This keeps source complexity from leaking across the whole codebase.

## Install

```bash
git clone https://github.com/mjaverto/imessage-to-markdown.git
cd imessage-to-markdown
npm install
npm run build
```

Package name:
- `messaging-markdown-exporter`

CLI binaries:
- `messaging-markdown-exporter`
- `imessage-to-markdown` (legacy alias)

## CLI usage

### iMessage

```bash
node dist/cli.js \
  --source imessage \
  --db-path ~/Library/Messages/chat.db \
  --output-dir ~/brain/iMessage
```

### Telegram

First-time auth (run once, interactively):

```bash
node dist/cli.js telegram-login
```

You'll be prompted for your apiId/apiHash (from <https://my.telegram.org/apps>),
phone number, login code, and optional 2FA password. The resulting session
string is saved under `~/.config/imessage-to-markdown/telegram/` with
`chmod 600`.

Subsequent unattended runs:

```bash
node dist/cli.js \
  --source telegram \
  --output-dir ~/brain/Telegram
```

### WhatsApp

```bash
node dist/cli.js \
  --source whatsapp \
  --output-dir ~/brain/WhatsApp
```

Reads `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite`
directly. No manual export. Override with `--whatsapp-db-path` if needed.

### Signal

```bash
node dist/cli.js \
  --source signal \
  --output-dir ~/brain/Signal \
  --my-name "Mike"
```

Reads the Signal Desktop SQLCipher database in place. The encryption key is
auto-retrieved from the macOS Keychain entry "Signal Safe Storage" and
unwrapped via Chromium's OSCrypt scheme. Override with `--signal-db-path`
and `--signal-config-path` if Signal is installed outside the default
location.

## Contacts integration (iMessage)

For the `imessage` source, the exporter resolves chat handles (phone
numbers, emails) to display names before writing markdown. The resolved
name is used in the markdown header, message senders, and the YAML
frontmatter.

Resolution strategy (in order):

1. **Direct AddressBook SQLite read (preferred).** The exporter reads
   every `AddressBook-v22.abcddb` under
   `~/Library/Application Support/AddressBook/Sources/<UUID>/` via
   `better-sqlite3-multiple-ciphers`. No Apple Events / Automation grant
   required -- only Full Disk Access, which the launchd runner already
   needs to read `chat.db`. This path is fast and works under `launchd`
   where JXA/osascript reliably fails with Apple Events error `-1743`
   (`errAEEventNotPermitted`).
2. **JXA via `osascript` (fallback).** If the SQLite path finds zero
   contacts (sources dir missing, schema change, custom Contacts setup
   on a network mount), the exporter falls back to the legacy JXA dump.
   This triggers a Contacts permission prompt the first time and only
   works from a context that has the Automation -> Contacts grant.
3. **Raw handles.** If both paths fail, the exporter logs a one-line
   warning and uses raw handles in the output -- exports still succeed.

Phone numbers are normalized to the last 10 digits for matching
(US-centric; documented tradeoff). Emails are lowercased and trimmed.
Handles present in multiple AddressBook sources are resolved with
first-writer-wins semantics using alphabetical source-directory order,
which is deterministic across runs.

### Flags

- `--no-contacts` -- skip Contacts.app entirely (no permission prompt).
- `--use-contact-names` -- when set, 1:1 chat output files are named after
  the resolved contact (e.g. `Karissa Smith.md`) instead of the slugified
  handle. Group chats keep slug-based filenames. Default off for backward
  compatibility with installed runners.

## YAML frontmatter

Every generated markdown file starts with a YAML frontmatter block:

```yaml
---
contact: "Karissa Smith"          # 1:1 chats only
participants: ["Alice", "Bob"]    # group chats only
handles: ["+15705551234"]
chat_id: 42                       # source-specific stable id (iMessage ROWID)
service: "iMessage"
source: "imessage"
message_count: 12
first_message: 2026-04-19T12:30:00.000Z
last_message: 2026-04-19T18:45:00.000Z
exported_at: 2026-04-19T19:30:00.000Z
contacts_resolved: false          # only when contacts lookup was attempted and empty
---
```

Downstream tooling (Obsidian, Dataview, custom indexers) can rely on the
shape above being stable across sources.

`contacts_resolved: false` is emitted **only** when contacts resolution
was requested for the source (i.e. `--no-contacts` was not passed and
the source is one that uses Contacts.app, currently `imessage` and
`whatsapp`) **and** the resolved map came back empty (both AddressBook
SQLite and JXA fallback failed). Use it to flag exports where raw phone
numbers / emails appear in place of names so downstream indexers do not
treat handles as canonical contact identities. The field is omitted on
successful resolution and on `--no-contacts` runs.

## Installer

The installer writes a launchd agent and a generated runner script that
invokes the CLI once per enabled source.

The runner reads `config.json` and loops over `enabledSources` (e.g.
`["imessage", "telegram", "whatsapp", "signal"]`). When `enabledSources`
is absent, it falls back to `[config.source]` for backward compatibility
with existing installs. Each source writes to either `outputDir` (single
source) or `outputDir/<source>` (multiple).

Fresh installs start with the selected source in `config.source`; to
enable more sources after install, add `"enabledSources": [...]` to
`config.json`.

Interactive:

```bash
npm run install:local
```

Non-interactive example:

```bash
node dist/install.js \
  --source imessage \
  --yes \
  --output-dir "$HOME/brain/iMessage" \
  --schedule 05:30 \
  --ac-power-only
```

Doctor mode:

```bash
node dist/install.js --doctor --source imessage
```

Uninstall:

```bash
node dist/install.js --uninstall
```

## Source-specific notes

### iMessage
- direct `chat.db` reads via the `sqlite3` CLI + tmpdir copy
- attributed-body cleanup is heuristic, not perfect
- Contacts resolution reads the AddressBook `.abcddb` SQLite files
  directly (no Automation / Apple Events grant required); JXA remains
  as a fallback for non-standard setups

### Telegram
- uses MTProto (gramjs `TelegramClient`) with a persistent `StringSession`
- per-dialog cursors under `~/.config/imessage-to-markdown/telegram/cursors.json`
- `FLOOD_WAIT_N` errors sleep `N` seconds and retry once
- `AUTH_KEY_UNREGISTERED` (session invalidated) emits a warning and exits 0 so scheduled jobs don't spam errors — re-run `telegram-login`

### WhatsApp
- reads `ChatStorage.sqlite` via the same `sqlite3` CLI + tmpdir copy pattern as iMessage
- joins `ZWAMESSAGE` with `ZWACHATSESSION`, `ZWAGROUPMEMBER`, `ZWAPROFILEPUSHNAME`, and `ZWAMEDIAITEM`
- sender resolution order: `ZCONTACTNAME` → `ZPUSHNAME` → `ZWAPROFILEPUSHNAME` → Contacts.app → `ZFIRSTNAME` → parsed JID user
- if WhatsApp Desktop holds the DB lock at the moment of copy, the adapter warns and returns an empty conversation list (the next run will retry)

### Signal
- unlocks Signal's SQLCipher v4 database using the Chromium OSCrypt scheme: PBKDF2-HMAC-SHA1 with salt `"saltysalt"`, 1003 iterations, AES-128-CBC with a 16-space IV, applied to the `encryptedKey` field in `config.json` retrieved from the macOS Keychain entry "Signal Safe Storage"
- falls back to the legacy plaintext `key` field when present
- SQLCipher v4 pragmas (`cipher='sqlcipher'`, `legacy=4`) are set before `PRAGMA key` — without them `better-sqlite3-multiple-ciphers` defaults to sqleet and rejects the key
- a `SIGNAL_DB_BUSY` (SQLITE_BUSY) is treated as a soft failure: the adapter exits 0 with a warning so cron runs while Signal is open don't fail the job
- **Sonoma 14.5+ caveat**: recent macOS versions changed how Electron's `safeStorage` negotiates with the Keychain. If the first run fails to retrieve the key, see [carderne/signal-export#133](https://github.com/carderne/signal-export/issues/133) — the workaround is usually one targeted Keychain permission dialog approval

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

## Current limitations

- Attachment handling is still simplified across all sources — the markdown
  renders an attachment marker but does not copy the attachment bytes.
- WhatsApp: newer Desktop builds emit opaque privacy-IDs (base64-like) in
  `ZFROMJID` for group messages instead of the `<phone>@s.whatsapp.net`
  form, so those senders are shown as the raw ID. 1:1 chats and older
  group data resolve correctly.
- Telegram: the adapter reads dialogs and messages, but media download is
  out of scope for this pass.
- Signal: requires Signal Desktop to be quit at the moment of read
  (SQLite write-locks the DB). Scheduled runs during an active Signal
  session will soft-fail with a warning.

## License

MIT
