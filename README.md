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
