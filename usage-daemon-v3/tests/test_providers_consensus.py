from pathlib import Path

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.consensus import parse

FIXTURE = Path(__file__).parent / "fixtures" / "consensus-client.json"
raw = FIXTURE.read_text(encoding="utf-8")


def test_parse_tier_null():
    assert parse(raw)["tier"] is None


def test_parse_three_windows_from_array_lengths():
    windows = parse(raw)["windows"]
    assert len(windows) == 3

    pro = next(w for w in windows if w["id"] == "pro_messages")
    assert pro["label"] == "Pro Messages"
    assert pro["used"] == 2
    assert pro["cap"] == 15
    assert pro["pct"] == pytest.approx(200 / 15)
    assert pro["color"] == "#E69F00"

    deep = next(w for w in windows if w["id"] == "deep_reviews")
    assert deep["used"] == 1
    assert deep["cap"] == 3
    assert deep["pct"] == pytest.approx(100 / 3)

    snap = next(w for w in windows if w["id"] == "snapshots")
    assert snap["used"] == 0
    assert snap["cap"] == 10
    assert snap["pct"] == 0


def test_parse_resets_at_is_last_reset_plus_30_days():
    assert parse(raw)["windows"][0]["resets_at"] == "2026-09-21T22:09:19.529Z"


def test_parse_meta_carries_raw_figures():
    assert parse(raw)["_consensus"] == {
        "pro_used": 2,
        "deep_used": 1,
        "snapshot_used": 0,
        "last_reset_date": "2026-08-22T22:09:19.529Z",
    }


def test_parse_no_active_session_raises():
    with pytest.raises(AuthExpiredError):
        parse('{"response": {"sessions": []}}')


def test_parse_no_public_metadata_raises():
    with pytest.raises(AuthExpiredError):
        parse('{"response": {"sessions": [{"status": "active", "user": {}}]}}')


def test_parse_unparseable_json_raises():
    with pytest.raises(AuthExpiredError):
        parse("not json")
