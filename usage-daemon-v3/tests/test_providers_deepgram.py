"""Deepgram provider parse tests (port of test/deepgram.test.js)."""

from __future__ import annotations

import json
import pathlib

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.deepgram import parse

HERE = pathlib.Path(__file__).parent
# Vendored balances response shape (amounts synthetic, PO ids scrubbed).
balances_body = json.loads(
    (HERE / "fixtures" / "deepgram-balances.json").read_text()
)


# fetch() ships an envelope { balances, projects, cap }.
def envelope(cap=None) -> str:
    return json.dumps({"balances": balances_body["balances"], "projects": 1, "cap": cap})


def test_parse_sums_balances_pct_null_without_cap():
    out = parse(envelope())
    w = next(x for x in out["windows"] if x["id"] == "balance")
    assert w["pct"] is None  # balance meter, no percentage without a cap
    assert w["resets_at"] is None
    assert w["color"] == "#009E73"
    assert abs(out["_balance"]["amount"] - 12.75) < 1e-9
    assert out["_balance"]["units"] == "USD"


def test_parse_with_balance_cap_gives_used_percentage():
    # cap 51 USD, 12.75 remaining -> 38.25 used -> 75% used
    out = parse(envelope(51))
    assert abs(out["windows"][0]["pct"] - 75) < 1e-9


def test_parse_used_pct_clamps_at_zero_when_topped_up_beyond_cap():
    out = parse(json.dumps({"balances": [{"amount": 100, "units": "USD"}], "cap": 50}))
    assert out["windows"][0]["pct"] == 0


def test_parse_empty_balances_is_zero_remaining_not_an_error():
    out = parse(json.dumps({"balances": [], "cap": 50}))
    assert out["_balance"]["amount"] == 0
    assert out["windows"][0]["pct"] == 100  # fully depleted against the cap


def test_parse_err_code_payload_throws_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse(json.dumps({
            "err_code": "INSUFFICIENT_PERMISSIONS",
            "err_msg": "need usage:read",
        }))


def test_parse_missing_balances_array_throws_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse(json.dumps({"projects": 1}))


def test_parse_window_carries_the_dollar_figure_not_just_a_pct():
    # Regression: the window used to be {pct: null} with no used/unit, so a
    # healthy prepaid account rendered as an empty bar with no number at all.
    out = parse(json.dumps({
        "balances": [{"amount": 12.5, "units": "usd"}, {"amount": 2.5, "units": "usd"}],
        "projects": 1,
        "cap": None,
    }))
    bal = next(w for w in out["windows"] if w["id"] == "balance")
    assert bal["pct"] is None, "no declared cap -> no percentage"
    assert bal["used"] == 15, "balances are summed across the account"
    assert bal["used_is_remaining"] is True
    assert bal["unit"] == "usd"
    assert bal["cap"] is None


def test_parse_declared_balance_cap_turns_balance_into_a_percentage_too():
    out = parse(json.dumps({
        "balances": [{"amount": 150, "units": "usd"}],
        "projects": 1,
        "cap": 200,
    }))
    bal = next(w for w in out["windows"] if w["id"] == "balance")
    assert bal["pct"] == 25, "50 of 200 consumed"
    assert bal["used"] == 150, "used still reports what remains"
    assert bal["cap"] == 200
