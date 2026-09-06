"""Parse tests for runpod against tests/fixtures/ (the JS suite has no provider
unit tests; fixtures are recorded API responses)."""

from pathlib import Path

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.runpod import parse

FIXTURE = Path(__file__).parent / "fixtures" / "runpod-myself.json"
raw = FIXTURE.read_text(encoding="utf-8")


def test_parse_balance_window():
    body = parse(raw)
    w = body["windows"][0]
    assert w["id"] == "balance"
    assert w["label"] == "Balance"
    assert w["letter"] == "Bl"
    assert w["pct"] is None  # pay-as-you-go, no cap
    assert w["used"] == 12.34
    assert w["used_is_remaining"] is True
    assert w["unit"] == "USD"
    assert w["resets_at"] is None
    assert w["color"] == "#009E73"
    assert w["will_deplete"] is False


def test_parse_tier_none_and_raw_stats():
    body = parse(raw)
    assert body["tier"] is None
    assert body["segments"] == []
    assert body["_runpod"] == {
        "client_balance": 12.34,
        "under_balance": False,
        "min_balance": 5,
    }


def test_under_balance_true_sets_will_deplete():
    body = parse('{"data": {"myself": {"clientBalance": 3.5, "underBalance": true, "minBalance": 5}}}')
    assert body["windows"][0]["will_deplete"] is True
    assert body["_runpod"]["min_balance"] == 5  # numeric minBalance passes through (JS parity)
    # absent minBalance -> null
    body = parse('{"data": {"myself": {"clientBalance": 3.5, "underBalance": true}}}')
    assert body["_runpod"]["min_balance"] is None


def test_graphql_errors_raise_auth_expired():
    with pytest.raises(AuthExpiredError, match="runpod: bad key"):
        parse('{"errors": [{"message": "bad key"}]}')
    with pytest.raises(AuthExpiredError, match="runpod: graphql error"):
        parse('{"errors": [{}]}')


def test_missing_myself_or_junk_raises_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse('{"data": {}}')
    with pytest.raises(AuthExpiredError):
        parse('{"data": {"myself": {"nope": 1}}}')
    with pytest.raises(AuthExpiredError):
        parse("not json")
