from __future__ import annotations

from collections import defaultdict
from datetime import datetime

from .models import ChatDayExport, ExportMessage
from .utils import slug_for_chat


def group_messages_by_chat_day(messages: list[ExportMessage]) -> list[ChatDayExport]:
    grouped: dict[tuple[str, str], list[ExportMessage]] = defaultdict(list)
    titles: dict[str, str] = {}
    for message in sorted(messages, key=lambda item: item.timestamp):
        chat_title = message.chat_display_name or ", ".join(message.participants) or "Unknown Chat"
        chat_key = slug_for_chat(message.chat_display_name, message.participants, fallback=f"chat-{message.message_id}")
        date_key = message.timestamp.date().isoformat()
        grouped[(chat_key, date_key)].append(message)
        titles[chat_key] = chat_title
    return [
        ChatDayExport(chat_key=chat_key, chat_title=titles[chat_key], date_key=date_key, messages=msgs)
        for (chat_key, date_key), msgs in sorted(grouped.items(), key=lambda item: (item[0][1], item[0][0]))
    ]


def render_message_line(message: ExportMessage) -> str:
    timestamp = message.timestamp.strftime("%H:%M")
    sender = message.sender.strip() or ("Me" if message.is_from_me else "Unknown")
    text = (message.text or "").strip() or "[no text]"
    line = f"- {timestamp} {sender}: {text}"
    if message.had_attachments:
        line += " [attachments omitted]"
    return line


def render_markdown(chat_day: ChatDayExport, generated_at: datetime | None = None) -> str:
    lines = [f"# {chat_day.chat_title}", f"Date: {chat_day.date_key}"]
    if generated_at:
        lines.append(f"Generated: {generated_at.isoformat(timespec='seconds')}")
    lines.append("")
    for message in chat_day.messages:
        lines.append(render_message_line(message))
    lines.append("")
    return "\n".join(lines)
