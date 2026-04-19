from datetime import datetime
from zoneinfo import ZoneInfo

from imessage_to_markdown.cli import parse_dt


def test_parse_dt_adds_timezone_when_missing():
    tz = ZoneInfo("America/New_York")
    value = parse_dt("2026-04-19T09:00:00", tz)
    assert value.tzinfo == tz


def test_parse_dt_preserves_existing_timezone():
    value = parse_dt("2026-04-19T13:00:00+00:00", ZoneInfo("America/New_York"))
    assert value == datetime(2026, 4, 19, 13, 0, tzinfo=ZoneInfo("UTC"))
