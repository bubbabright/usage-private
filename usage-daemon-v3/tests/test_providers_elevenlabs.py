from pathlib import Path

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.elevenlabs import parse

FIXTURE = Path(__file__).parent / "fixtures" / "elevenlabs-subscription.json"
raw = FIXTURE.read_text(encoding="utf-8")


def test_parse_tier_from_tier_field():
    assert parse(raw)["tier"] == "creator"


def test_parse_characters_window_shows_remaining_cap_reset():
    windows = parse(raw)["windows"]
    w = next(w for w in windows if w["id"] == "characters")
    assert w["label"] == "Characters"
    assert w["used"] == 75000
    assert w["used_is_remaining"] is True
    assert w["cap"] == 100000
    assert w["pct"] == 25
    assert w["resets_at"] == "2025-01-31T20:54:18.000Z"
    assert w["color"] == "#0072B2"


def test_parse_voice_slots_window_present_when_fields_exist():
    windows = parse(raw)["windows"]
    w = next(w for w in windows if w["id"] == "voice_slots")
    assert w["used"] == 2
    assert w["cap"] == 10
    assert w["pct"] == 20


def test_parse_voice_slots_absent_when_fields_missing():
    windows = parse('{"tier": "starter", "character_count": 1000, "character_limit": 10000, "status": "active"}')["windows"]
    assert len(windows) == 1
    assert windows[0]["id"] == "characters"


def test_missing_character_count_raises():
    with pytest.raises(AuthExpiredError):
        parse("{}")


def test_unparseable_json_raises():
    with pytest.raises(AuthExpiredError):
        parse("not json")
