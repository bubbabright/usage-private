from pathlib import Path

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.tavily import parse

FIXTURE = Path(__file__).parent / "fixtures" / "tavily-account.json"
raw = FIXTURE.read_text(encoding="utf-8")


def test_parse_tier_from_current_plan():
    assert parse(raw)["tier"] == "free"


def test_parse_credits_window_shows_remaining_not_consumed():
    windows = parse(raw)["windows"]
    assert len(windows) == 1
    w = windows[0]
    assert w["id"] == "credits"
    assert w["label"] == "Credits"
    assert w["letter"] == "Cr"
    assert w["used"] == 658
    assert w["used_is_remaining"] is True
    assert w["cap"] == 1000
    assert w["unit"] == "searches"
    assert w["color"] == "#D55E00"
    assert w["resets_at"] == "2026-08-14T13:25:19.683Z"
    assert w["will_deplete"] is False


def test_parse_pct_is_consumed_fraction():
    assert parse(raw)["windows"][0]["pct"] == pytest.approx(34.2)


def test_parse_pct_null_when_limit_absent():
    w = parse('{"usage": 50}')["windows"][0]
    assert w["pct"] is None
    assert w["cap"] is None
    assert w["used"] is None


def test_parse_meta_carries_raw_figures():
    assert parse(raw)["_credits"] == {
        "usage": 342,
        "limit": 1000,
        "plan": "free",
        "plan_display_name": "Free",
        "last_reset": "2026-08-14T13:25:19.683Z",
    }


def test_parse_error_payload_raises():
    with pytest.raises(AuthExpiredError):
        parse('{"error": "unauthorized"}')


def test_parse_success_false_raises():
    with pytest.raises(AuthExpiredError):
        parse('{"success": false}')


def test_parse_no_usage_raises():
    with pytest.raises(AuthExpiredError):
        parse("{}")


def test_parse_unparseable_json_raises():
    with pytest.raises(AuthExpiredError):
        parse("not json")
