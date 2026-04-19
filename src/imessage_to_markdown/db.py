from __future__ import annotations

import plistlib
import re
import shutil
import sqlite3
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .models import ExportMessage

APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=UTC)
ATTRIBUTED_STRING_RE = re.compile(rb"NSString\x00?(.*?)\x86", re.DOTALL)


@dataclass(slots=True)
class FetchOptions:
    start: datetime
    end: datetime
    my_name: str = "Mike"
    include_empty: bool = False


@contextmanager
def readable_db_copy(db_path: Path):
    db_path = db_path.expanduser()
    if not db_path.exists():
        raise FileNotFoundError(f"Messages database not found: {db_path}")
    with tempfile.TemporaryDirectory(prefix="imessage-export-") as tmpdir:
        tmp = Path(tmpdir) / "chat.db"
        shutil.copy2(db_path, tmp)
        wal = db_path.with_suffix(".db-wal")
        shm = db_path.with_suffix(".db-shm")
        if wal.exists():
            shutil.copy2(wal, tmp.with_suffix(".db-wal"))
        if shm.exists():
            shutil.copy2(shm, tmp.with_suffix(".db-shm"))
        yield tmp


def apple_time_to_datetime(value: int | float | None) -> datetime:
    if value is None:
        raise ValueError("Missing message timestamp")
    seconds = float(value)
    if seconds > 10_000_000_000:
        seconds = seconds / 1_000_000_000
    return APPLE_EPOCH + timedelta(seconds=seconds)


def extract_text(text: str | None, attributed_body: bytes | None) -> str:
    if text:
        return text.strip()
    if not attributed_body:
        return ""
    try:
        parsed = plistlib.loads(attributed_body)
        for key in ("NSString", "NS.string", "text"):
            value = parsed.get(key) if isinstance(parsed, dict) else None
            if isinstance(value, str) and value.strip():
                return value.strip()
    except Exception:
        pass
    match = ATTRIBUTED_STRING_RE.search(attributed_body)
    if match:
        cleaned = match.group(1).decode("utf-8", errors="ignore").replace("\x00", "").strip()
        if cleaned:
            return cleaned
    raw = attributed_body.decode("utf-8", errors="ignore").replace("\x00", " ")
    raw = re.sub(r"\s+", " ", raw).strip()
    return raw[:5000]


def fetch_messages(db_path: Path, options: FetchOptions) -> list[ExportMessage]:
    query = """
    SELECT
      m.ROWID AS message_id,
      m.date AS message_date,
      m.is_from_me,
      m.text,
      m.attributedBody,
      m.service,
      COALESCE(a.attachment_count, 0) AS attachment_count,
      h.id AS sender_handle,
      c.display_name AS chat_display_name,
      GROUP_CONCAT(DISTINCT h2.id) AS participant_handles
    FROM message m
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN chat c ON c.ROWID = cmj.chat_id
    LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
    LEFT JOIN handle h2 ON h2.ROWID = chj.handle_id
    LEFT JOIN (
      SELECT message_id, COUNT(*) AS attachment_count
      FROM message_attachment_join
      GROUP BY message_id
    ) a ON a.message_id = m.ROWID
    WHERE m.date >= ? AND m.date < ?
    GROUP BY m.ROWID
    ORDER BY m.date ASC
    """
    start_apple = (options.start.astimezone(UTC) - APPLE_EPOCH).total_seconds() * 1_000_000_000
    end_apple = (options.end.astimezone(UTC) - APPLE_EPOCH).total_seconds() * 1_000_000_000
    messages: list[ExportMessage] = []
    with readable_db_copy(db_path) as safe_db:
        connection = sqlite3.connect(f"file:{safe_db}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        try:
            for row in connection.execute(query, (start_apple, end_apple)):
                text = extract_text(row["text"], row["attributedBody"])
                if not text and not options.include_empty and not row["attachment_count"]:
                    continue
                timestamp = apple_time_to_datetime(row["message_date"]).astimezone()
                participants = sorted({p for p in (row["participant_handles"] or "").split(",") if p})
                sender = options.my_name if row["is_from_me"] else (row["sender_handle"] or "Unknown")
                messages.append(
                    ExportMessage(
                        message_id=int(row["message_id"]),
                        timestamp=timestamp,
                        sender=sender,
                        text=text,
                        is_from_me=bool(row["is_from_me"]),
                        service=row["service"],
                        had_attachments=bool(row["attachment_count"]),
                        chat_display_name=row["chat_display_name"],
                        participants=participants,
                    )
                )
        finally:
            connection.close()
    return messages
