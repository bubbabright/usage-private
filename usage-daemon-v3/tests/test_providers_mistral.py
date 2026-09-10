"""Port of test/mistral.test.js — parse() is pure, runs against vendored fixtures."""

import json
import datetime as _dtmod
from pathlib import Path

import pytest

from usage_daemon.providers.mistral import (
    API_COLOR,
    SPEND_COLOR,
    VIBE_COLOR,
    AuthExpiredError,
    extract_spend_total,
    next_month_start_utc,
    parse,
    vibe_interval_seconds,
)

HERE = Path(__file__).parent
FIXTURES = HERE / "fixtures"

vibe_raw = (FIXTURES / "mistral-vibe.json").read_text()
usage_raw = (FIXTURES / "mistral-usage.json").read_text()
limit_raw = (FIXTURES / "mistral-spend-limit.json").read_text()


def _dt(*args):
    return _dtmod.datetime(*args, tzinfo=_dtmod.timezone.utc)


def _leg(pct, payg_enabled=False, reset_at="2026-09-01T00:00:00Z"):
    return {
        "usage_percentage": pct,
        "initial_budget": 10,
        "currency": "USD",
        "reset_at": reset_at,
        "payg_enabled": payg_enabled,
    }


# Build a billing.budget tRPC envelope (the current vibe/api meter shape).
def budget_envelope(*, vibe_pct=0, api_pct=None, payg_enabled=False):
    body = {"vibe_budget": _leg(vibe_pct, payg_enabled=payg_enabled)}
    if api_pct is not None:
        body["api_budget"] = _leg(api_pct)
    return json.dumps({"result": {"data": {"json": body}}})


def envelope(*, vibe=None, usage=None, spend_limit=None):
    return json.dumps({"vibe": vibe, "usage": usage, "spend_limit": spend_limit})


def test_parse_vibe_ready_made_percentage_passthrough():
    # fixture = 0% vibe, 0% api
    out = parse(envelope(vibe=vibe_raw))
    windows, tier = out["windows"], out["tier"]
    w = next(x for x in windows if x["id"] == "vibe_monthly")
    assert w["pct"] == 0
    assert "used" not in w
    assert "cap" not in w
    assert "unit" not in w
    assert w["resets_at"] == "2026-09-01T00:00:00Z"  # literal passthrough from fixture
    assert w["letter"] == "Vb"
    assert w["label"] == "Vibe"
    assert w["color"] == VIBE_COLOR
    assert w["will_deplete"] is False
    assert tier == "free"
    assert out["_vibe"] == {"pct": 0, "resetAt": "2026-09-01T00:00:00Z"}


def test_parse_api_monthly_bonus_window_from_same_call():
    out = parse(envelope(vibe=vibe_raw))
    windows = out["windows"]
    w = next(x for x in windows if x["id"] == "api_monthly")
    assert w["pct"] == 0
    assert w["letter"] == "Ap"
    assert w["label"] == "API"
    assert w["color"] == API_COLOR
    assert len(windows) == 2  # vibe_monthly + api_monthly, no admin legs


def test_parse_vibe_mid_value_percentage_passthrough():
    out = parse(envelope(vibe=budget_envelope(vibe_pct=55)))
    w = next(x for x in out["windows"] if x["id"] == "vibe_monthly")
    assert w["pct"] == 55


def test_parse_vibe_usage_percentage_clamped():
    over = parse(envelope(vibe=budget_envelope(vibe_pct=150)))
    assert next(w for w in over["windows"] if w["id"] == "vibe_monthly")["pct"] == 100
    under = parse(envelope(vibe=budget_envelope(vibe_pct=-5)))
    assert next(w for w in under["windows"] if w["id"] == "vibe_monthly")["pct"] == 0


def test_parse_vibe_payg_enabled_tier_null_pct_still_passed():
    # Unverified against a live PAYG account — pinning unconditional passthrough.
    out = parse(envelope(vibe=budget_envelope(vibe_pct=40, payg_enabled=True)))
    assert out["tier"] is None
    assert next(w for w in out["windows"] if w["id"] == "vibe_monthly")["pct"] == 40


def test_parse_spend_window_with_fixtures():
    out = parse(envelope(vibe=vibe_raw, usage=usage_raw, spend_limit=limit_raw))
    assert out["tier"] == "free"
    assert len(out["windows"]) == 3
    spend = next(w for w in out["windows"] if w["id"] == "monthly_spend")
    assert spend["letter"] == "$"
    assert spend["label"] == "Spend"
    assert spend["pct"] == 0
    assert spend["color"] == SPEND_COLOR
    # fixture usage is month 7 / year 2026 -> first of next month
    assert spend["resets_at"] == "2026-08-01T00:00:00Z"


def test_parse_vibe_only_two_windows_no_throw_when_admin_legs_null():
    out = parse(envelope(vibe=vibe_raw))
    assert len(out["windows"]) == 2
    assert any(w["id"] == "vibe_monthly" for w in out["windows"])
    assert any(w["id"] == "api_monthly" for w in out["windows"])


def test_parse_spend_with_no_monthly_limit_pct_null_window_still_present():
    unlimited = json.dumps({"amount": 0, "no_monthly_limit": True})
    usage = json.dumps({"total": 3.5, "month": 7, "year": 2026})
    # spend-only path (no vibe)
    out = parse(envelope(vibe=None, usage=usage, spend_limit=unlimited))
    spend = next(w for w in out["windows"] if w["id"] == "monthly_spend")
    assert spend["pct"] is None
    assert spend["resets_at"] == "2026-08-01T00:00:00Z"


def test_parse_spend_non_zero_pct():
    usage = json.dumps({"total": 2.5})
    limit = json.dumps({"amount": 10, "no_monthly_limit": False})
    out = parse(envelope(vibe=None, usage=usage, spend_limit=limit))
    assert next(w for w in out["windows"] if w["id"] == "monthly_spend")["pct"] == 25


def test_parse_garbage_vibe_alone_raises_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse(envelope(vibe='{"unrelated":true}'))
    with pytest.raises(AuthExpiredError):
        parse(envelope(vibe="not json"))
    with pytest.raises(AuthExpiredError):
        parse(envelope())
    with pytest.raises(AuthExpiredError):
        parse("not json")


def test_parse_spend_alone_without_vibe_still_ok():
    out = parse(envelope(vibe=None, usage=usage_raw, spend_limit=limit_raw))
    assert len(out["windows"]) == 1
    assert out["windows"][0]["id"] == "monthly_spend"


def test_extract_spend_total():
    assert extract_spend_total({"total": 4.2}) == 4.2
    assert extract_spend_total({"completion": 1, "ocr": 2, "audio": 0.5}) == 3.5
    assert extract_spend_total({}) is None


def test_next_month_start_utc():
    assert next_month_start_utc(_dt(2026, 7, 15)) == "2026-08-01T00:00:00Z"


def test_vibe_interval_seconds_default_300_when_not_maxed():
    assert vibe_interval_seconds(99, "2026-09-01T00:00:00Z") == 300
    assert vibe_interval_seconds(None, "2026-09-01T00:00:00Z") == 300  # cold start


def test_vibe_interval_seconds_maxed_capped_at_24h():
    now = _dt(2026, 8, 16)
    reset_at = "2026-09-01T00:00:00Z"  # ~16 days out
    assert vibe_interval_seconds(100, reset_at, now) == 24 * 3600


def test_vibe_interval_seconds_maxed_reset_sooner_than_cap():
    now = _dt(2026, 8, 31, 20, 0, 0)
    reset_at = "2026-09-01T00:00:00Z"  # 4h out
    assert vibe_interval_seconds(100, reset_at, now) == 4 * 3600


def test_vibe_interval_seconds_maxed_reset_in_past():
    now = _dt(2026, 9, 2)
    assert vibe_interval_seconds(100, "2026-09-01T00:00:00Z", now) == 300


def test_vibe_interval_seconds_maxed_unparseable_reset():
    assert vibe_interval_seconds(100, "not-a-date") == 300
