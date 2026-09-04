"""Port of test/claude.test.js — parse() against the oauth/usage fixture."""

import json
import re
from pathlib import Path

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.claude import parse

FIXTURE = Path(__file__).parent / "fixtures" / "claude-usage.json"
raw = FIXTURE.read_text(encoding="utf-8")


def test_parse_session_and_weekly_windows():
    windows = parse(raw)["windows"]
    session = next(w for w in windows if w["id"] == "session")
    weekly = next(w for w in windows if w["id"] == "weekly")
    assert session["pct"] == 12
    assert session["resets_at"] == "2026-07-13T18:00:00Z"
    assert session["letter"] == "5h"
    assert session["color"] == "#E69F00"
    assert weekly["pct"] == 34
    assert weekly["resets_at"] == "2026-07-18T00:00:00Z"
    assert weekly["letter"] == "Wk"
    assert weekly["color"] == "#56B4E9"


def test_parse_tier_is_none():
    assert parse(raw)["tier"] is None


def test_parse_no_segments():
    assert parse(raw)["segments"] == []


def test_parse_extra_usage_enabled_becomes_credits_window():
    body = json.dumps({
        "five_hour": {"utilization": 100, "resets_at": "2026-07-23T20:50:00Z"},
        "seven_day": {"utilization": 92, "resets_at": "2026-07-24T14:00:00Z"},
        "extra_usage": {
            "is_enabled": True,
            "monthly_limit": 2000,
            "used_credits": 1361,
            "utilization": 68.05,
            "currency": "USD",
            "decimal_places": 2,
        },
    })
    windows = parse(body)["windows"]
    assert len(windows) == 3
    cr = next(w for w in windows if w["id"] == "extra_usage")
    assert cr["pct"] == 68.05
    assert cr["used"] == 13.61  # 1361 minor units @ dp=2
    assert cr["cap"] == 20  # 2000 @ dp=2
    assert cr["unit"] == "USD"
    assert cr["letter"] == "Cr"
    assert cr["color"] == "#009E73"
    # 1st of next month, 00:00 UTC (API gives no reset date)
    assert re.search(r"-01T00:00:00(\+00:00|Z)$", cr["resets_at"])


def test_parse_extra_usage_disabled_or_absent_gives_two_windows():
    off = '{"five_hour": {"utilization": 1, "resets_at": "2026-07-23T20:50:00Z"}, "seven_day": {"utilization": 2, "resets_at": "2026-07-24T14:00:00Z"}, "extra_usage": {"is_enabled": false, "monthly_limit": 2000, "used_credits": 0}}'
    assert len(parse(off)["windows"]) == 2
    absent = '{"five_hour": {"utilization": 1, "resets_at": "2026-07-23T20:50:00Z"}, "seven_day": {"utilization": 2, "resets_at": "2026-07-24T14:00:00Z"}}'
    assert len(parse(absent)["windows"]) == 2


def test_parse_missing_windows_raises_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse('{"unrelated": true}')


def test_parse_unparseable_body_raises_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse("not json")