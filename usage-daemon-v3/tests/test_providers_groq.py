from pathlib import Path

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.groq import parse, parse_duration

FIXTURE = Path(__file__).parent / "fixtures" / "groq-ratelimit.json"
envelope = FIXTURE.read_text(encoding="utf-8")


def test_parse_builds_daily_requests_window_only():
    out = parse(envelope)
    assert out["tier"] is None
    assert len(out["windows"]) == 1
    rpd = next(w for w in out["windows"] if w["id"] == "daily_requests")
    assert rpd["pct"] == pytest.approx(100 * (1 - 14350 / 14400))
    assert rpd["resets_at"] == "2026-07-27T13:00:00.000Z"
    assert rpd["color"] == "#CC79A7"
    assert rpd["label"] == "Requests/day"


def test_parse_only_requests_headers_present():
    windows = parse('{"limit_requests": 100, "remaining_requests": 50}')["windows"]
    assert len(windows) == 1
    assert windows[0]["id"] == "daily_requests"
    assert windows[0]["label"] == "Requests/day"
    assert windows[0]["pct"] == 50


def test_parse_no_usable_headers_raises():
    with pytest.raises(AuthExpiredError):
        parse("{}")


def test_parse_unparseable_envelope_raises():
    with pytest.raises(AuthExpiredError):
        parse("not json")


def test_parse_duration_parses_groq_duration_strings():
    assert parse_duration("2m59.56s") == pytest.approx(179.56)
    assert parse_duration("1.2s") == pytest.approx(1.2)
    assert parse_duration("120ms") == pytest.approx(0.12)
    assert parse_duration("45s") == pytest.approx(45)
    assert parse_duration("3h2m59.56s") == pytest.approx(10979.56)
    assert parse_duration(None) is None
    assert parse_duration("garbage") is None
