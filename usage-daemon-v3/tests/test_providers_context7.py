from pathlib import Path

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.context7 import parse

FIXTURE = Path(__file__).parent / "fixtures" / "context7-stats.json"
raw = FIXTURE.read_text(encoding="utf-8")


def test_parse_tier_from_owner_plan():
    assert parse(raw)["tier"] == "free"


def test_parse_requests_window_shows_remaining_not_consumed():
    windows = parse(raw)["windows"]
    assert len(windows) == 1
    w = windows[0]
    assert w["id"] == "requests"
    assert w["label"] == "Requests/mo"
    assert w["letter"] == "Rq"
    assert w["used"] == 997
    assert w["used_is_remaining"] is True
    assert w["cap"] == 1000
    assert w["unit"] == "requests"
    assert w["color"] == "#F0E442"
    assert w["resets_at"] is None
    assert w["will_deplete"] is False


def test_parse_pct_is_consumed_fraction():
    assert parse(raw)["windows"][0]["pct"] == pytest.approx(0.3)


def test_parse_pct_null_without_quota_limit():
    w = parse('{"success": true, "data": {"userRequests": 5}}')["windows"][0]
    assert w["pct"] is None
    assert w["cap"] is None


def test_parse_meta_carries_raw_figures():
    assert parse(raw)["_context7"] == {
        "quotaLimit": 1000,
        "userRequests": 3,
        "ownerPlan": "free",
        "creditBalance": 0,
    }


def test_parse_success_false_raises():
    with pytest.raises(AuthExpiredError):
        parse('{"success": false}')


def test_parse_missing_data_raises():
    with pytest.raises(AuthExpiredError):
        parse('{"success": true}')


def test_parse_no_user_requests_raises():
    with pytest.raises(AuthExpiredError):
        parse('{"success": true, "data": {}}')


def test_parse_unparseable_json_raises():
    with pytest.raises(AuthExpiredError):
        parse("not json")
