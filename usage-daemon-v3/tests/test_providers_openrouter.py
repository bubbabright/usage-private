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
    assert len(windows) == 1
    assert windows[0]["id"] == "key_limit"


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
