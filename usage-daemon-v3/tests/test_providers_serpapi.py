from pathlib import Path

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.serpapi import parse

FIXTURE = Path(__file__).parent / "fixtures" / "serpapi-account.json"
envelope = FIXTURE.read_text(encoding="utf-8")


def test_parse_monthly_window_shows_remaining_and_consumed_pct():
    out = parse(envelope)
    w = next(x for x in out["windows"] if x["id"] == "monthly_searches")
    assert out["tier"] is None
    assert w["pct"] == pytest.approx(80.14)
    assert w["used"] == 5958
    assert w["used_is_remaining"] is True
    assert w["cap"] == 30000
    assert w["unit"] == "searches"
    assert w["color"] == "#E69F00"
    assert w["resets_at"] == "2026-09-10"
    assert out["_serpapi"]["plan_searches_left"] == 5958
    assert out["_serpapi"]["total_searches_left"] == 5958


def test_parse_no_monthly_plan_falls_back_to_total_searches_left():
    out = parse('{"account_status": "Active", "plan_renewal_date": null, "searches_per_month": null, "this_month_usage": null, "total_searches_left": 1234, "extra_credits": 100}')
    w = next(x for x in out["windows"] if x["id"] == "total_searches")
    assert w["pct"] is None
    assert w["used"] == 1234
    assert w["used_is_remaining"] is True
    assert out["_serpapi"]["plan"] is None
    assert out["_serpapi"]["total_searches_left"] == 1234


def test_parse_over_limit_usage_clamps_at_100():
    out = parse('{"searches_per_month": 1000, "this_month_usage": 1500}')
    assert out["windows"][0]["pct"] == 100


def test_parse_error_payload_raises_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse('{"error": "UNAUTHORIZED"}')


def test_parse_missing_figures_raises_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse('{"account_status": "Active"}')


def test_parse_unparseable_envelope_raises_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse("not json")
