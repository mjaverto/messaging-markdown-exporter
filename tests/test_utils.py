from imessage_to_markdown.utils import looks_like_system_chat, sanitize_filename


def test_sanitize_filename_strips_bad_chars():
    assert sanitize_filename(" Karissa / Family: 💬 ") == "Karissa - Family"


def test_sanitize_filename_fallback():
    assert sanitize_filename("***", fallback="chat") == "chat"


def test_looks_like_system_chat():
    assert looks_like_system_chat("Verification Code", []) is True
    assert looks_like_system_chat("Karissa", ["+15555551212"]) is False
