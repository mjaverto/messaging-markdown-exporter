from __future__ import annotations

import re
import unicodedata
from pathlib import Path


WHITESPACE_RE = re.compile(r"\s+")
INVALID_FILENAME_RE = re.compile(r"[^A-Za-z0-9._ -]+")
SYSTEM_CHAT_RE = re.compile(
    r"(verification code|otp|2fa|do not reply|no-reply|automated|alert|notification)",
    re.IGNORECASE,
)


def sanitize_filename(value: str, fallback: str = "chat") -> str:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    value = value.strip().replace("/", "-")
    value = INVALID_FILENAME_RE.sub("", value)
    value = WHITESPACE_RE.sub(" ", value).strip(" .")
    return value[:120] or fallback


def ensure_directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def looks_like_system_chat(name: str | None, participants: list[str]) -> bool:
    haystack = " ".join(filter(None, [name, *participants]))
    return bool(haystack and SYSTEM_CHAT_RE.search(haystack))


def slug_for_chat(name: str | None, participants: list[str], fallback: str) -> str:
    if name:
        return sanitize_filename(name, fallback=fallback)
    if participants:
        joined = ", ".join(sorted(participants))
        return sanitize_filename(joined, fallback=fallback)
    return fallback
