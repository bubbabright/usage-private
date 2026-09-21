"""Parse tests for llm7 against tests/fixtures/ (the JS suite has no provider
unit tests; fixtures are recorded API responses)."""

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.llm7 import create, next_utc_midnight, parse
from pathlib import Path

FIXTURE = Path(__file__).parent / "fixtures" / "llm7-quota.json"
raw = FIXTURE.read_text(encoding="utf-8")


def test_parse_single_daily_tokens_window():
    body = parse(raw)
    w = body["windows"][0]
    assert w["id"] == "daily_tokens"
    assert w["label"] == "Tokens"
    assert w["letter"] == "Tk"
    assert w["pct"] == pytest.approx(0.2431)  # 100 * 2431 / 1_000_000
    assert w["used"] == 2431
    assert w["cap"] == 1_000_000
    assert w["unit"] == "tokens"
    assert w["resets_at"].endswith("Z")
    assert w["color"] == "#56B4E9"
    assert w["will_deplete"] is False


def test_next_utc_midnight_is_in_the_future():
    from datetime import datetime, timezone

    reset = datetime.fromisoformat(next_utc_midnight().replace("Z", "+00:00"))
    assert reset > datetime.now(timezone.utc)
    assert reset.hour == 0


def test_parse_tier_from_fixture():
    assert parse(raw)["tier"] == "free"


def test_parse_remaining_surfaced_for_meta():
    assert parse(raw)["_llm7"]["remaining"] == 997569


def test_parse_no_segments():
    assert parse(raw)["segments"] == []


def test_error_shape_raises_auth_expired():
    with pytest.raises(AuthExpiredError, match="llm7: nope"):
        parse('{"error": "invalid", "message": "nope"}')


def test_missing_or_degenerate_figures_raise_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse('{"used_tokens": 1}')  # no limit
    with pytest.raises(AuthExpiredError):
        parse('{"used_tokens": 1, "limit_tokens": 0}')  # limit <= 0
    with pytest.raises(AuthExpiredError):
        parse("not json")


def test_configure_and_set_auth_state():
    p = create()
    p["configure"]({"api_token": "  jwt-abc  "})
    p["set_auth"](" tok-xyz ")  # setAuth wins as the latest write
    p["configure"]({})  # no keys -> unchanged
    # token:'' clears, token:null keeps existing (mirrors JS ?/?? semantics)
    p["configure"]({"token": None})
    p["configure"]({"api_token": ""})
    # No network access to observe state; just ensure no crash and contract keys.
    assert all(k in p for k in ("id", "label", "auth", "config", "configure", "fetch", "interval_seconds", "parse", "set_auth", "meta"))
