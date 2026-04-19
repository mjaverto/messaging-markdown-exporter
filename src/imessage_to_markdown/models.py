from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass(slots=True)
class ExportMessage:
    message_id: int
    timestamp: datetime
    sender: str
    text: str
    is_from_me: bool
    service: str | None = None
    had_attachments: bool = False
    chat_display_name: str | None = None
    participants: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ChatDayExport:
    chat_key: str
    chat_title: str
    date_key: str
    messages: list[ExportMessage]
