"""Parse tests for abacus against tests/fixtures/ (the JS suite has no provider
unit tests; fixtures are recorded API responses)."""

from pathlib import Path

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.abacus import parse

FIXTURE = Path(__file__).parent / "fixtures" / "abacus-usage.json"
raw = FIXTURE.read_text(encoding="utf-8")


def test_parse_compute_points_window():
    body = parse(raw)
    w = body["windows"][0]
    assert w["id"] == "compute_points"
    assert w["label"] == "Credits"
    assert w["letter"] == "Cr"
    # centi-credits: 200001/100 used, 200000/100 cap -> 100.0005 clamped to 100
    assert w["pct"] == 100
    assert w["used"] == pytest.approx(2000.01)
    assert w["cap"] == pytest.approx(2000.0)
    assert w["unit"] == "credits"
    assert w["resets_at"] == "2026-09-07T09:01:07+00:00"  # bucket EXPIRY, not refresh
    assert w["expires_at"] == "2026-09-07T09:01:07+00:00"
    assert w["color"] == "#CC79A7"
    assert w["will_deplete"] is False
    assert w["note"] == "Free-tier credits — one-time grant, does not refresh"


def test_parse_tier_and_raw_stats():
    body = parse(raw)
    assert body["tier"] == "free"
    assert body["segments"] == []
    assert body["_abacus"] == {
        "used": 200001,
        "cap": 200000,
        "is_free_tier": True,
        "free_tier_expires": "2026-09-07T09:01:07+00:00",
    }


def test_non_free_tier_omits_note():
    body = parse(
        '{"success": true, "result": {"userInfo": {"organization": '
        '{"subscriptionTier": "pro", "computePointInfo": {"currMonthAvailPoints": 500000, "currMonthUsage": 123456}}}}}'
    )
    w = body["windows"][0]
    assert w["pct"] == pytest.approx(24.6912)
    assert "note" not in w
    assert body["tier"] == "pro"


def test_unsuccessful_or_missing_org_raises_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse('{"success": false}')
    with pytest.raises(AuthExpiredError):
        parse('{"success": true, "result": {"userInfo": {}}}')
    with pytest.raises(AuthExpiredError):
        parse("not json")


def test_missing_compute_point_figures_raises_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse('{"success": true, "result": {"userInfo": {"organization": {"subscriptionTier": "free"}}}}')
