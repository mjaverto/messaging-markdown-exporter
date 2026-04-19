# imessage-to-markdown

Export Apple Messages from macOS `chat.db` into clean markdown files, one conversation per day, with an install flow that can set up daily automation for you.

This tool is built for local-first personal archiving, Brain-style ingestion, and simple daily syncs from Messages into markdown.

## Why TypeScript

This project started in Python, then moved to TypeScript because the long-term goal is not just a script, it is an easy installable tool that more people will actually want to touch, tweak, and contribute to.

TypeScript is a better fit for that packaging and CLI ergonomics story.

## What it does

- reads `~/Library/Messages/chat.db` by default
- exports the last day by default, or any date range you specify
- writes one markdown file per conversation per day
- includes timestamps and sender attribution
- skips media payloads, but notes when a message had attachments
- supports excluding chats by regex
- tries to skip obvious system-ish threads by default
- includes an installer that can create and load a `launchd` agent
- supports interactive install and fully non-interactive CLI install

## What it does not do

- it does not send messages
- it does not upload anything anywhere
- it does not export actual image, video, or audio payloads
- it does not perfectly reconstruct every iMessage rich-text edge case

## Requirements

- macOS
- Node.js 20+
- `sqlite3` available on the system
- `jq` available on the system for the generated runner script
- Full Disk Access for the terminal app or app that will read `~/Library/Messages/chat.db`

## macOS permission note

Apple protects `~/Library/Messages/chat.db` behind Full Disk Access.

You will likely need to give **Terminal**, **iTerm**, or whatever launches Node full disk access:

- System Settings
- Privacy & Security
- Full Disk Access
- enable your terminal app

Without that, reads from `chat.db` will fail.

## Install

```bash
git clone https://github.com/mjaverto/imessage-to-markdown.git
cd imessage-to-markdown
npm install
npm run build
```

## Basic usage

Export last 24 hours to `./exports`:

```bash
node dist/cli.js
```

Or with `tsx` during development:

```bash
npx tsx src/cli.ts --output-dir "$HOME/brain/inbox/messages"
```

### Examples

Export last 3 days:

```bash
node dist/cli.js --days 3 --output-dir "$HOME/brain/inbox/messages"
```

Export an exact range:

```bash
node dist/cli.js \
  --start 2026-04-19T00:00:00-04:00 \
  --end 2026-04-20T00:00:00-04:00 \
  --output-dir "$HOME/brain/inbox/messages"
```

Exclude chats matching a regex:

```bash
node dist/cli.js --exclude-chat-regex 'Amazon|CVS|verification|OTP'
```

Emit JSON summary:

```bash
node dist/cli.js --json
```

## One-click style install

There are two install modes.

### 1. Interactive install

This prompts for the output directory and automation settings:

```bash
npm run install:local
```

You will be asked:
- where markdown files should be written
- what time the export should run daily
- whether to run only on AC power
- whether to run `qmd embed` afterward
- what your sent-message name should be
- which regex to use for ignored chats

### 2. Fully non-interactive install

This is good for agents, scripts, and power users:

```bash
node dist/install.js \
  --yes \
  --output-dir "$HOME/brain/inbox/messages" \
  --schedule 05:30 \
  --ac-power-only \
  --run-qmd-embed \
  --qmd-command "qmd embed" \
  --my-name "Mike" \
  --exclude-chat-regex 'Amazon|CVS|verification|OTP'
```

That writes:
- a config file in `~/.imessage-to-markdown/`
- a runner shell script in `~/.imessage-to-markdown/`
- a LaunchAgent plist in `~/Library/LaunchAgents/`

Then it loads the LaunchAgent with `launchctl`.

## How automation works

The installer creates a daily `launchd` job.

At runtime the job:
- checks whether AC-only mode is enabled
- if enabled, skips the run when the Mac is on battery
- exports messages to markdown
- optionally runs a follow-up command like `qmd embed`

So the battery-aware logic is handled in the generated runner script, not by `launchd` itself.

## Output format

Example file:

```md
# Karissa
Date: 2026-04-19
Generated: 2026-04-19T13:42:13.000Z

- 08:12 Mike: Heading out now
- 08:13 Karissa: Can you grab coffee on the way back?
- 08:14 Mike: Yep
```

Files are written like:

```text
exports/
  2026-04-19/
    Karissa.md
    Family Chat.md
```

## Brain / qmd suggestion

If your Brain system already ingests a folder tree, point `--output-dir` there directly.

Example:

```bash
node dist/cli.js --output-dir "$HOME/brain/inbox/messages"
qmd embed
```

Or let the installer wire that into the scheduled job.

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

## Limitations

- Apple changes the Messages schema over time.
- `attributedBody` extraction is best-effort.
- group chat naming can be inconsistent if a chat has no display name.
- reactions, edits, replies, and some system messages are not yet richly rendered.
- media is intentionally omitted.
- the installer currently expects `jq` to be available for config parsing in the generated runner script.

## License

MIT
