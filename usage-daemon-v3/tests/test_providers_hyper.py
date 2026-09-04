"""Port of test/hyper.test.js — parse() + parse_refresh_text() fixtures."""

import json
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.hyper import parse, parse_refresh_text

FIXTURE = Path(__file__).parent / "fixtures" / "hyper-credits.json"
raw = FIXTURE.read_text(encoding="utf-8")


def test_parse_tier_is_free():
    assert parse(raw)["tier"] == "free"


def test_parse_hypercredits_window():
    windows = parse(raw)["windows"]
    assert len(windows) == 1
    w = windows[0]
    assert w["id"] == "hypercredits"
    assert w["label"] == "Credits"
    assert w["letter"] == "Hc"
    assert w["used"] == 22  # 100 - 78
    assert w["cap"] == 100
    assert w["unit"] == "credits"
    assert w["color"] == "#0072B2"
    assert w["pct"] == 22


def test_parse_meta_balance():
    assert parse(raw)["_hyper"]["balance"] == 78


def test_parse_zero_balance_is_100pct():
    windows = parse('{"balance": 0}')["windows"]
    assert windows[0]["used"] == 100
    assert windows[0]["pct"] == 100


def test_parse_full_balance_is_0pct():
    windows = parse('{"balance": 100}')["windows"]
    assert windows[0]["used"] == 0
    assert windows[0]["pct"] == 0


def test_parse_auth_error_raises():
    body = json.dumps({"error": {"message": "invalid key", "type": "authentication_error"}})
    with pytest.raises(AuthExpiredError):
        parse(body)


def test_parse_empty_object_raises():
    with pytest.raises(AuthExpiredError):
        parse("{}")


def _iso_to_ms(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def test_parse_refresh_text_4_weeks():
    iso = parse_refresh_text("Next Hypercredit Refresh in 4 weeks")
    assert iso
    now = int(time.time() * 1000)
    ms = _iso_to_ms(iso)
    assert now + 27 * 86_400_000 < ms < now + 29 * 86_400_000


def test_parse_refresh_text_1_week():
    iso = parse_refresh_text("Next Hypercredit Refresh in 1 week")
    assert iso
    now = int(time.time() * 1000)
    ms = _iso_to_ms(iso)
    assert now + 6 * 86_400_000 < ms < now + 8 * 86_400_000


def test_parse_refresh_text_2_days():
    iso = parse_refresh_text("Next Hypercredit Refresh in 2 days")
    assert iso
    now = int(time.time() * 1000)
    ms = _iso_to_ms(iso)
    assert now + 1 * 86_400_000 < ms < now + 3 * 86_400_000


def test_parse_refresh_text_no_match_returns_none():
    assert parse_refresh_text("<html>no refresh text here</html>") is None