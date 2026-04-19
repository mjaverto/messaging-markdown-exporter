# Messaging Markdown Exporter

Export conversations from multiple messaging apps into a shared markdown format.

## Supported sources

| Source | Input | Support level |
|---|---|---|
| `imessage` | macOS `chat.db` | deepest native support |
| `telegram` | Telegram Desktop JSON export | good first-pass adapter |
| `whatsapp` | exported WhatsApp `.txt` chat logs | good first-pass adapter |
| `signal` | Signal markdown exports from tools like `signal-export` | import adapter |

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

## CLI usage

### iMessage

```bash
node dist/cli.js \
  --source imessage \
  --db-path ~/Library/Messages/chat.db \
  --output-dir ~/brain/iMessage
```

### Telegram

```bash
node dist/cli.js \
  --source telegram \
  --export-path ~/Downloads/telegram-export/result.json \
  --output-dir ~/brain/messages
```

### WhatsApp

```bash
node dist/cli.js \
  --source whatsapp \
  --export-path ~/Downloads/_chat.txt \
  --output-dir ~/brain/messages
```

### Signal

```bash
node dist/cli.js \
  --source signal \
  --export-path ~/signal-chats \
  --output-dir ~/brain/messages
```

## Contacts integration (iMessage)

For the `imessage` source, the exporter dumps Contacts.app once per run via
JXA and resolves chat handles (phone numbers, emails) to display names. The
resolved name is used in the markdown header, message senders, and the YAML
frontmatter.

The first run will trigger a Contacts permission prompt for the binary
running `osascript` (your terminal app, or the launchd-spawning process).
If access is denied or unavailable, the exporter logs a one-line warning
and falls back to raw handles -- exports still succeed.

Phone numbers are normalized to the last 10 digits for matching (US-centric;
documented tradeoff). Emails are lowercased and trimmed.

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
---
```

Downstream tooling (Obsidian, Dataview, custom indexers) can rely on the
shape above being stable across sources.

## Installer

The installer now supports choosing a source and scheduling export jobs.

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
- still the strongest adapter
- uses direct `chat.db` reads
- attributed-body cleanup is heuristic, not perfect

### Telegram
- designed for Telegram Desktop JSON exports
- best when fed clean exported chat history

### WhatsApp
- designed for exported text logs
- backup/database parsing is future work

### Signal
- designed to ingest exported markdown
- best paired with an external exporter like `carderne/signal-export`

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

## Current limitations

- iMessage remains the deepest native integration
- Telegram, WhatsApp, and Signal support are adapter-first, not exhaustive
- attachment handling is still simplified in shared markdown output
- some stale source-format quirks will still need fixture-driven hardening over time

## License

MIT
