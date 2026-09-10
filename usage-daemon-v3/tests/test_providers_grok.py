"""Port of test/grok.test.js — parse() is pure, runs against the vendored fixture."""

import base64
import json
from pathlib import Path

import pytest

from usage_daemon.providers.grok import (
    AuthExpiredError,
    MONTHLY_COLOR,
    WEEKLY_COLOR,
    parse,
    parse_grok_credits_config,
)

HERE = Path(__file__).parent
FIXTURES = HERE / "fixtures"
raw = (FIXTURES / "grok-usage.json").read_text()


def test_parse_monthly_and_weekly_windows():
    out = parse(raw)
    windows = out["windows"]
    monthly = next(w for w in windows if w["id"] == "monthly")
    weekly = next(w for w in windows if w["id"] == "weekly")

    # monthly: used 1234 / limit 10000 (cents) -> 12.34%
    assert monthly["pct"] == pytest.approx(12.34)
    assert monthly["resets_at"] == "2026-08-01T00:00:00Z"
    assert monthly["letter"] == "Mo"
    assert monthly["color"] == MONTHLY_COLOR

    # weekly: fixed32 credit_usage_percent = 42.5, reset unix 2_000_000_000
    assert weekly["pct"] == pytest.approx(42.5)
    assert weekly["resets_at"] == "2033-05-18T03:33:20Z"  # unix 2e9
    assert weekly["letter"] == "Wk"
    assert weekly["color"] == WEEKLY_COLOR


def test_parse_grok_inverts_claude_colors():
    out = parse(raw)
    windows = out["windows"]
    assert next(w for w in windows if w["id"] == "monthly")["color"] == "#56B4E9"
    assert next(w for w in windows if w["id"] == "weekly")["color"] == "#E69F00"


def test_parse_tier_null_no_segments():
    out = parse(raw)
    assert out["tier"] is None
    assert out["segments"] == []


def test_parse_val_wrapped_and_config_nested_billing_both_unwrap():
    # bare scalars, no .config nesting -> same result path
    flat = json.dumps({
        "billing": json.dumps({"used": 500, "monthlyLimit": 10000, "billingPeriodEnd": "X"}),
        "credits": None,
    })
    out = parse(flat)
    assert next(w for w in out["windows"] if w["id"] == "monthly")["pct"] == 5


def test_parse_weekly_best_effort_null_garbage_credits():
    no_credits = json.dumps({
        "billing": json.dumps({"config": {"used": 1000, "monthlyLimit": 10000, "billingPeriodEnd": "X"}}),
        "credits": None,
    })
    out = parse(no_credits)
    assert next(w for w in out["windows"] if w["id"] == "monthly")["pct"] == 10
    weekly = next(w for w in out["windows"] if w["id"] == "weekly")
    assert weekly["pct"] is None
    assert weekly["resets_at"] is None

    # unparseable credits (not a protobuf frame) also degrade gracefully
    bad_credits = json.dumps({
        "billing": json.dumps({"config": {"used": 1000, "monthlyLimit": 10000}}),
        "credits": base64.b64encode(bytes([0xFF, 0xFF, 0xFF])).decode(),
    })
    out = parse(bad_credits)
    assert next(w for w in out["windows"] if w["id"] == "weekly")["pct"] is None


def test_parse_missing_used_monthly_limit_raises_auth_expired():
    bad = json.dumps({"billing": json.dumps({"config": {"foo": 1}}), "credits": None})
    with pytest.raises(AuthExpiredError):
        parse(bad)


def test_parse_limit_zero_is_no_monthly_cap_not_auth_expired():
    zero = json.dumps({
        "billing": json.dumps({"used": 5, "monthlyLimit": 0}),
        "credits": None,
    })
    out = parse(zero)
    monthly = next(w for w in out["windows"] if w["id"] == "monthly")
    assert monthly["pct"] is None  # no divide-by-zero


def test_parse_unparseable_billing_or_envelope_raises_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse("not json")
    with pytest.raises(AuthExpiredError):
        parse(json.dumps({"billing": "not json", "credits": None}))


# --- weekly protobuf scanner edge cases (parse_grok_credits_config) ---


def _varint(n: int) -> bytes:
    out = bytearray()
    v = n
    while v > 0x7F:
        out.append((v & 0x7F) | 0x80)
        v >>= 7
    out.append(v & 0x7F)
    return bytes(out)


def _frame(payload: bytes) -> bytes:
    n = len(payload)
    return bytes([0x00, (n >> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF]) + payload


def test_parse_grok_credits_config_proto3_zero_pct():
    # field1 msg { field6: varint=1 (usage period), field5 msg { field1: varint ts } }
    inner_inner = b"\x08" + _varint(2_000_000_000)  # [1,5,1] reset
    inner = (
        b"\x30\x01"  # field6 varint=1 -> [1,6]
        + b"\x2a" + bytes([len(inner_inner)]) + inner_inner  # field5 msg
    )
    msg = b"\x0a" + bytes([len(inner)]) + inner
    parsed = parse_grok_credits_config(_frame(msg))
    assert parsed["usedPercent"] == 0
    assert parsed["resetsAtMs"] == 2_000_000_000 * 1000


def test_parse_grok_credits_config_empty_garbage():
    assert parse_grok_credits_config(b"") is None
    assert parse_grok_credits_config(None) is None

