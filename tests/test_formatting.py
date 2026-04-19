from datetime import datetime
from zoneinfo import ZoneInfo

from imessage_to_markdown.formatting import group_messages_by_chat_day, render_markdown, render_message_line
from imessage_to_markdown.models import ExportMessage

TZ = ZoneInfo("America/New_York")


def make_message(message_id: int, hour: int, text: str, *, day: int = 19) -> ExportMessage:
    return ExportMessage(
        message_id=message_id,
        timestamp=datetime(2026, 4, day, hour, 30, tzinfo=TZ),
        sender="Mike" if message_id % 2 else "Karissa",
        text=text,
        is_from_me=bool(message_id % 2),
        had_attachments=(message_id == 3),
        chat_display_name="Karissa",
        participants=["Karissa"],
    )


def test_render_message_line_attachment_marker():
    line = render_message_line(make_message(3, 8, "Photo incoming"))
    assert "[attachments omitted]" in line


def test_group_messages_by_chat_day_splits_days():
    groups = group_messages_by_chat_day([
        make_message(1, 8, "hey", day=19),
        make_message(2, 9, "yo", day=20),
    ])
    assert len(groups) == 2
    assert groups[0].date_key == "2026-04-19"
    assert groups[1].date_key == "2026-04-20"


def test_render_markdown_contains_header_and_lines():
    group = group_messages_by_chat_day([make_message(1, 8, "hello there")])[0]
    rendered = render_markdown(group)
    assert "# Karissa" in rendered
    assert "- 08:30 Mike: hello there" in rendered
