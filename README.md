# imessage-to-markdown

Export Apple Messages from macOS `chat.db` into clean markdown files, one conversation per day.

This is meant for local-first personal archiving, knowledge-base ingestion, and workflows like Brain or `qmd` indexing.

## What it does

- reads `~/Library/Messages/chat.db` by default
- exports the last day by default, or any date range you specify
- writes one markdown file per conversation per day
- includes timestamps and sender attribution
- skips media payloads, but notes when a message had attachments
- supports excluding chats by regex
- tries to skip obvious system-ish threads by default

## What it does not do

- it does not send messages
- it does not upload anything anywhere
- it does not export actual image/video/audio payloads
- it does not perfectly reconstruct every modern iMessage rich-text edge case

## macOS permission note

Apple protects `~/Library/Messages/chat.db` behind Full Disk Access.

You will likely need to give **Terminal**, **iTerm**, or whatever launches Python full disk access:

- System Settings
- Privacy & Security
- Full Disk Access
- enable your terminal app

Without that, reads from `chat.db` will fail.

## Install

### Local clone

```bash
git clone https://github.com/mjaverto/imessage-to-markdown.git
cd imessage-to-markdown
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

### Quick run without install

```bash
PYTHONPATH=src python3 -m imessage_to_markdown --help
```

## Usage

Export last 24 hours to `./exports`:

```bash
python3 -m imessage_to_markdown
```

Export last 3 days into a Brain ingest folder:

```bash
python3 -m imessage_to_markdown \
  --days 3 \
  --output-dir "$HOME/brain/inbox/messages"
```

Export an exact range:

```bash
python3 -m imessage_to_markdown \
  --start 2026-04-19T00:00:00 \
  --end 2026-04-20T00:00:00 \
  --output-dir "$HOME/brain/inbox/messages"
```

Exclude chats matching a regex:

```bash
python3 -m imessage_to_markdown \
  --exclude-chat-regex 'Amazon|CVS|verification|OTP'
```

Emit JSON summary:

```bash
python3 -m imessage_to_markdown --json
```

## Output format

Example file:

```md
# Karissa
Date: 2026-04-19
Generated: 2026-04-19T09:42:13-04:00

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
python3 -m imessage_to_markdown \
  --output-dir "$HOME/brain/inbox/messages"
qmd embed
```

If `qmd embed` is too expensive to run every day, point this exporter at a staging folder and let your existing ingest pipeline pick it up.

## launchd example

Create `~/Library/LaunchAgents/com.mjaverto.imessage-to-markdown.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.mjaverto.imessage-to-markdown</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/zsh</string>
      <string>-lc</string>
      <string>cd ~/src/imessage-to-markdown && source .venv/bin/activate && python -m imessage_to_markdown --output-dir ~/brain/inbox/messages && qmd embed</string>
    </array>

    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>
      <integer>5</integer>
      <key>Minute</key>
      <integer>30</integer>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/tmp/imessage-to-markdown.out</string>
    <key>StandardErrorPath</key>
    <string>/tmp/imessage-to-markdown.err</string>
  </dict>
</plist>
```

Then load it:

```bash
launchctl unload ~/Library/LaunchAgents/com.mjaverto.imessage-to-markdown.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.mjaverto.imessage-to-markdown.plist
```

## Development

Run tests:

```bash
PYTHONPATH=src python3 -m pytest
```

## Limitations

- Apple changes the Messages schema over time.
- `attributedBody` parsing is best-effort, not perfect.
- group chat naming can be inconsistent if a chat has no display name.
- reactions, edits, thread replies, and some system messages are not yet rendered in a rich way.
- media is intentionally omitted.

## License

MIT
