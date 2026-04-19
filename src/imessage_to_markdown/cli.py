from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .exporter import ExportOptions, export_markdown

DEFAULT_DB = Path("~/Library/Messages/chat.db").expanduser()
DEFAULT_OUTPUT = Path("./exports")
DEFAULT_TZ = ZoneInfo("America/New_York")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export Apple Messages/iMessage to markdown")
    parser.add_argument("--db-path", type=Path, default=DEFAULT_DB, help="Path to chat.db")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT, help="Directory for markdown output")
    parser.add_argument("--days", type=int, default=1, help="Export last N days, default 1")
    parser.add_argument("--start", help="Start datetime ISO8601, overrides --days")
    parser.add_argument("--end", help="End datetime ISO8601, default now")
    parser.add_argument("--timezone", default="America/New_York", help="Timezone for naive datetimes")
    parser.add_argument("--my-name", default="Mike", help="Label for sent messages")
    parser.add_argument("--exclude-chat-regex", help="Regex to exclude chats by display name")
    parser.add_argument("--include-system", action="store_true", help="Include system-ish chats")
    parser.add_argument("--include-empty", action="store_true", help="Include empty messages that only had metadata")
    parser.add_argument("--json", action="store_true", help="Print JSON summary")
    return parser.parse_args()


def parse_dt(value: str, tz: ZoneInfo) -> datetime:
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=tz)
    return dt


def resolve_range(args: argparse.Namespace) -> tuple[datetime, datetime]:
    tz = ZoneInfo(args.timezone)
    end = parse_dt(args.end, tz) if args.end else datetime.now(tz)
    if args.start:
        start = parse_dt(args.start, tz)
    else:
        start = end - timedelta(days=args.days)
    return start, end


def main() -> int:
    args = parse_args()
    start, end = resolve_range(args)
    result = export_markdown(
        ExportOptions(
            db_path=args.db_path,
            output_dir=args.output_dir,
            start=start,
            end=end,
            my_name=args.my_name,
            exclude_chat_regex=args.exclude_chat_regex,
            skip_system=not args.include_system,
            include_empty=args.include_empty,
        )
    )
    summary = {
        "files_written": result.files_written,
        "messages_exported": result.messages_exported,
        "output_paths": [str(path) for path in result.output_paths],
        "start": start.isoformat(),
        "end": end.isoformat(),
    }
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(f"Wrote {result.files_written} file(s), exported {result.messages_exported} message(s).")
        for path in result.output_paths:
            print(path)
    return 0
