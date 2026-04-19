from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .db import FetchOptions, fetch_messages
from .formatting import group_messages_by_chat_day, render_markdown
from .utils import ensure_directory, looks_like_system_chat, sanitize_filename


@dataclass(slots=True)
class ExportResult:
    files_written: int
    messages_exported: int
    output_paths: list[Path]


@dataclass(slots=True)
class ExportOptions:
    db_path: Path
    output_dir: Path
    start: datetime
    end: datetime
    my_name: str = "Mike"
    exclude_chat_regex: str | None = None
    skip_system: bool = True
    include_empty: bool = False


def export_markdown(options: ExportOptions) -> ExportResult:
    raw_messages = fetch_messages(
        options.db_path,
        FetchOptions(start=options.start, end=options.end, my_name=options.my_name, include_empty=options.include_empty),
    )
    pattern = re.compile(options.exclude_chat_regex) if options.exclude_chat_regex else None
    filtered = []
    for message in raw_messages:
        title = message.chat_display_name or ", ".join(message.participants)
        if pattern and pattern.search(title or ""):
            continue
        if options.skip_system and looks_like_system_chat(title, message.participants):
            continue
        filtered.append(message)
    grouped = group_messages_by_chat_day(filtered)
    output_paths: list[Path] = []
    for chat_day in grouped:
        day_dir = ensure_directory(options.output_dir / chat_day.date_key)
        filename = sanitize_filename(chat_day.chat_title, fallback=chat_day.chat_key)
        path = day_dir / f"{filename}.md"
        path.write_text(render_markdown(chat_day, generated_at=datetime.now().astimezone()), encoding="utf-8")
        output_paths.append(path)
    return ExportResult(files_written=len(output_paths), messages_exported=len(filtered), output_paths=output_paths)
