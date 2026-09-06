"""Parse tests for github against tests/fixtures/ (the JS suite has no provider
unit tests; fixtures are recorded API responses)."""

import datetime as _dt

from pathlib import Path

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.github import parse

FIXTURE = Path(__file__).parent / "fixtures" / "github-rate-limit.json"
raw = FIXTURE.read_text(encoding="utf-8")


def test_parse_three_windows():
    windows = parse(raw)["windows"]
    assert [w["id"] for w in windows] == ["core", "search", "graphql"]


def test_core_window_values():
    core = parse(raw)["windows"][0]
    assert core["label"] == "REST Calls"
    assert core["letter"] == "Rc"
    # pct = 100 * (5000 - 4987) / 5000 = 0.26
    assert core["pct"] == pytest.approx(0.26)
    assert core["used"] == 4987  # remaining calls, not consumed
    assert core["used_is_remaining"] is True
    assert core["cap"] == 5000
    assert core["unit"] == "calls"
    assert core["resets_at"] == _dt.datetime.fromtimestamp(1738356858, _dt.timezone.utc).isoformat()
    assert core["color"] == "#0072B2"


def test_search_and_graphql_windows():
    windows = parse(raw)["windows"]
    search = windows[1]
    assert search["label"] == "Search Calls"
    assert search["letter"] == "Sr"
    assert search["pct"] == 0  # 30 - 30 remaining, no usage
    assert search["color"] == "#E69F00"
    graphql = windows[2]
    assert graphql["letter"] == "Gq"
    assert graphql["pct"] == 0
    assert graphql["color"] == "#CC79A7"


def test_parse_tier_none_and_raw_stats():
    body = parse(raw)
    assert body["tier"] is None
    assert body["segments"] == []
    assert body["_github"] == {"core_remaining": 4987, "core_limit": 5000}


def test_resources_missing_raises_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse('{"rate": {"limit": 5000}}')  # no resources


def test_zero_limit_resource_is_skipped_pct_null():
    body = parse('{"resources": {"core": {"limit": 0, "remaining": 0, "reset": 1738356858}}}')
    assert body["windows"][0]["pct"] is None
    assert body["windows"][0]["cap"] == 0


def test_junk_raises_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse("not json")
