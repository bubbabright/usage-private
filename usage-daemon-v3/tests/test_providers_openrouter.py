from pathlib import Path

import json
import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.openrouter import parse

HERE = Path(__file__).parent / "fixtures"
key_text = (HERE / "openrouter-key.json").read_text(encoding="utf-8")
credits_text = (HERE / "openrouter-credits.json").read_text(encoding="utf-8")
envelope = json.dumps({"key": key_text, "credits": credits_text})


def test_parse_both_windows_from_key_and_credits():
    out = parse(envelope)
    key_limit = next(w for w in out["windows"] if w["id"] == "key_limit")
    credits = next(w for w in out["windows"] if w["id"] == "credits")

    assert out["tier"] == "paid"
    assert key_limit["pct"] == pytest.approx(58.8)
    assert key_limit["used"] == pytest.approx(58.8)
    assert key_limit["cap"] == 100
    assert key_limit["unit"] == "USD"
    assert key_limit["resets_at"] is None
    assert key_limit["color"] == "#56B4E9"

    assert credits["pct"] == pytest.approx(58.8)
    assert credits["resets_at"] is None
    assert credits["color"] == "#E69F00"


def test_parse_credits_window_alone_when_key_missing():
    windows = parse(json.dumps({"key": None, "credits": credits_text}))["windows"]
    assert len(windows) == 1
    assert windows[0]["id"] == "credits"


def test_parse_key_window_alone_when_credits_missing():
    windows = parse(json.dumps({"key": key_text, "credits": None}))["windows"]
    assert len(windows) == 2
    assert windows[0]["id"] == "key_limit"
    assert any(w["id"] == "rate_limit" for w in windows)


def test_parse_rate_limit_window_from_key_rate_limit_field():
    out = parse(json.dumps({"key": key_text, "credits": None}))
    rl = next(w for w in out["windows"] if w["id"] == "rate_limit")
    assert rl["used"] == 1000
    assert rl["used_is_remaining"] is True
    assert rl["unit"] == "requests"
    assert rl["pct"] is None
    assert "10s" in rl["label"]
    assert out["_openrouter"]["rate_limit"] == {"requests": 1000, "interval": "10s"}


def test_parse_no_rate_limit_window_when_field_absent():
    out = parse(json.dumps({
        "key": json.dumps({"data": {"usage": 150, "limit": 100}}),
        "credits": None,
    }))
    assert not any(w["id"] == "rate_limit" for w in out["windows"])


def test_parse_unlimited_key_drops_key_limit_window():
    unlimited = json.dumps({"data": {"usage": 5, "limit": None, "is_free_tier": True}})
    out = parse(json.dumps({"key": unlimited, "credits": credits_text}))
    assert out["tier"] == "free"
    assert not any(w["id"] == "key_limit" for w in out["windows"])
    assert any(w["id"] == "credits" for w in out["windows"])


def test_parse_pct_clamps_at_100_when_usage_exceeds_limit():
    over = json.dumps({"data": {"usage": 150, "limit": 100}})
    out = parse(json.dumps({"key": over, "credits": None}))
    assert next(w for w in out["windows"] if w["id"] == "key_limit")["pct"] == 100


def test_parse_empty_envelope_throws_but_not_auth_expired():
    with pytest.raises(Exception) as exc:
        parse(json.dumps({"key": None, "credits": None}))
    assert not isinstance(exc.value, AuthExpiredError)


def test_parse_uncapped_key_with_no_purchased_credits_still_reports_balance():
    out = parse(json.dumps({
        "key": json.dumps({"data": {"limit": None, "usage": 0.25, "is_free_tier": False}}),
        "credits": json.dumps({"data": {"total_credits": 0, "total_usage": 0.25}}),
    }))
    bal = next(w for w in out["windows"] if w["id"] == "credits")
    assert bal["pct"] is None
    assert bal["used"] == -0.25
    assert bal["unit"] == "USD"
    assert bal["used_is_remaining"] is True


def test_parse_funded_account_reports_credit_percentage():
    out = parse(json.dumps({
        "key": None,
        "credits": json.dumps({"data": {"total_credits": 40, "total_usage": 10}}),
    }))
    bal = next(w for w in out["windows"] if w["id"] == "credits")
    assert bal["pct"] == 25
    assert bal["used"] == 10
    assert bal["cap"] == 40
    assert bal["unit"] == "USD"


def test_parse_key_limit_prefers_server_remaining_and_reset_window_usage():
    out = parse(json.dumps({
        "key": json.dumps({"data": {
            "limit": 500,
            "limit_remaining": 454.542594979,
            "limit_reset": "monthly",
            "usage": 433.286754736,
            "usage_daily": 3.404645509,
            "usage_weekly": 3.404645509,
            "usage_monthly": 45.457405021,
            "rate_limit": {"requests": 120, "interval": "10s"},
        }}),
        "credits": None,
    }))
    key = next(w for w in out["windows"] if w["id"] == "key_limit")
    assert key["pct"] == pytest.approx(9.0914810042)
    assert key["used"] == pytest.approx(45.457405021)
    assert key["cap"] == 500
    assert key["unit"] == "USD"
    assert key["resets_at"] == "monthly"
    assert out["_openrouter"]["limit_remaining"] == pytest.approx(454.542594979)
    assert out["_openrouter"]["usage_monthly"] == pytest.approx(45.457405021)
    assert out["_openrouter"]["rate_limit"] == {"requests": 120, "interval": "10s"}


def test_parse_key_limit_falls_back_to_reset_window_usage_when_remaining_missing():
    out = parse(json.dumps({
        "key": json.dumps({"data": {
            "limit": 500,
            "limit_reset": "monthly",
            "usage": 433.286754736,
            "usage_monthly": 45.457405021,
        }}),
        "credits": None,
    }))
    key = next(w for w in out["windows"] if w["id"] == "key_limit")
    assert key["pct"] == pytest.approx(9.0914810042)
    assert key["used"] == pytest.approx(45.457405021)


def test_parse_negative_server_remaining_is_exhausted_quota():
    out = parse(json.dumps({
        "key": json.dumps({"data": {
            "limit": 500,
            "limit_remaining": -5,
            "limit_reset": "monthly",
            "usage_monthly": 45.457405021,
        }}),
        "credits": None,
    }))
    key = next(w for w in out["windows"] if w["id"] == "key_limit")
    assert key["pct"] == 100
    assert key["used"] == 500


# --- free_requests window (Management-key /analytics/query) -----------------

analytics_text = (HERE / "openrouter-analytics.json").read_text(encoding="utf-8")


def test_parse_free_requests_window_from_analytics():
    out = parse(json.dumps({"key": key_text, "credits": credits_text, "analytics": analytics_text}))
    fr = next(w for w in out["windows"] if w["id"] == "free_requests")

    # fixture credits: total_credits 100 >= $10 => 1000/day tier
    assert fr["cap"] == 1000
    assert fr["used"] == 84  # string "84" in fixture coerced + summed
    assert fr["pct"] == pytest.approx(8.4)
    assert fr["unit"] == "requests"
    assert fr["color"] == "#CC79A7"
    # next UTC midnight, as epoch seconds (runner's to_host_iso renders it)
    import datetime as dt
    resets = dt.datetime.fromtimestamp(fr["resets_at"], tz=dt.timezone.utc)
    now = dt.datetime.now(dt.timezone.utc)
    assert resets > now
    assert (resets - now) <= dt.timedelta(days=1)
    assert resets.replace(hour=0, minute=0, second=0, microsecond=0) == resets


def test_parse_free_requests_absent_without_analytics_and_meta_marks_degraded():
    out = parse(json.dumps({"key": key_text, "credits": credits_text}))
    assert not any(w["id"] == "free_requests" for w in out["windows"])
    m = out["_openrouter"]
    assert m["free_requests_auth"] == "degraded"
    assert m["daily_requests"] is None
    assert m["daily_request_cap"] == 1000  # cap still derivable from credits


def test_parse_free_requests_meta_flags_management_key_and_byok():
    key_with_flags = json.dumps({
        "data": {
            "limit": 100.0,
            "limit_remaining": 41.2,
            "usage": 58.8,
            "is_free_tier": False,
            "is_management_key": True,
            "byok_usage": 1.5,
            "byok_usage_daily": 0.25,
            "byok_usage_weekly": 0.75,
            "byok_usage_monthly": 1.5,
            "rate_limit": {"requests": -1, "interval": "10s"},
        }
    })
    out = parse(json.dumps({"key": key_with_flags, "credits": credits_text, "analytics": analytics_text}))
    m = out["_openrouter"]
    assert m["is_management_key"] is True
    assert m["free_requests_auth"] == "management_key"
    assert m["daily_requests"] == 84
    assert m["daily_request_cap"] == 1000
    assert m["byok_usage"] == 1.5
    assert m["byok_usage_daily"] == 0.25
    assert m["byok_usage_weekly"] == 0.75
    assert m["byok_usage_monthly"] == 1.5
    # deprecated sentinel must NOT resurrect the rate_limit window
    assert not any(w["id"] == "rate_limit" for w in out["windows"])


def test_parse_free_requests_cap_derivation_thresholds():
    def cap_for(credits_payload, is_free_tier=None):
        key = json.dumps({"data": {"limit": None, "usage": 0, "is_free_tier": is_free_tier}})
        out = parse(json.dumps({
            "key": key,
            "credits": credits_payload,
            "analytics": analytics_text,
        }))
        return next(w for w in out["windows"] if w["id"] == "free_requests")["cap"]

    # lifetime total_credits is the signal: >= 10 => 1000
    assert cap_for(json.dumps({"data": {"total_credits": 10.0, "total_usage": 0}})) == 1000
    assert cap_for(json.dumps({"data": {"total_credits": 100.0, "total_usage": 0}})) == 1000
    # below threshold => 50, even though key says paid
    assert cap_for(json.dumps({"data": {"total_credits": 5.0, "total_usage": 0}}), is_free_tier=False) == 50
    # no credits data: is_free_tier fallback
    assert cap_for(None, is_free_tier=False) == 1000  # paid before => 1000
    assert cap_for(None, is_free_tier=True) == 50
    assert cap_for(None) == 50  # unknown => conservative 50


def test_parse_free_requests_handles_empty_and_malformed_analytics():
    # zero-requests day: empty rows => degraded meta, no window
    empty = json.dumps({"data": {"data": [], "metadata": {"row_count": 0}, "cachedAt": 1}})
    out = parse(json.dumps({"key": key_text, "credits": credits_text, "analytics": empty}))
    assert not any(w["id"] == "free_requests" for w in out["windows"])
    assert out["_openrouter"]["free_requests_auth"] == "degraded"

    # malformed payload ignored, parse still succeeds on key/credits
    out2 = parse(json.dumps({"key": key_text, "credits": credits_text, "analytics": "not-json{"}))
    assert any(w["id"] == "key_limit" for w in out2["windows"])
    assert not any(w["id"] == "free_requests" for w in out2["windows"])


def test_utc_day_bounds_epoch_and_iso_agree():
    from usage_daemon.providers.openrouter import _utc_day_bounds_epoch, _utc_day_bounds_iso
    import datetime as dt

    now = dt.datetime(2026, 9, 11, 15, 30, 45, tzinfo=dt.timezone.utc)
    s, e = _utc_day_bounds_epoch(now)
    assert dt.datetime.fromtimestamp(s, dt.timezone.utc) == dt.datetime(2026, 9, 11, tzinfo=dt.timezone.utc)
    assert dt.datetime.fromtimestamp(e, dt.timezone.utc) == dt.datetime(2026, 9, 12, tzinfo=dt.timezone.utc)

    iso_s, iso_e = _utc_day_bounds_iso(now)
    # API contract (verified live 2026-09-11): time_range values MUST be ISO
    # strings — numbers and epoch-as-string both 400 with "Invalid ISO datetime".
    assert iso_s == "2026-09-11T00:00:00Z"
    assert iso_e == "2026-09-12T00:00:00Z"
