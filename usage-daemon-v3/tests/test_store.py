"""Port of test/store.test.js — history round-trip + read cache (sqlite_store)."""

import json
import sqlite3

import pytest

from usage_daemon.sqlite_store import Store, history_row


@pytest.fixture()
def store(tmp_path):
    return Store(state_dir=str(tmp_path))


def snap(t, pct):
    return {
        "provider": "demo",
        "t": t,
        "tier": "pro",
        "status": "ok",
        "stale": False,
        "windows": [{"id": "w5h", "label": "5h", "pct": pct, "resets_at": "2026-09-07T12:00:00Z"}],
        "segments": [],
    }


def test_read_on_provider_with_no_history_returns_empty(store):
    assert store.read("nobody") == []


def test_append_then_read_round_trips_compact_row_shape(store):
    store.append("demo", snap(1000, 12))
    rows = store.read("demo")
    assert rows == [{"t": 1000, "tier": "pro", "w5h": 12}]


def test_cached_read_returns_identical_rows_when_nothing_changed(store):
    store.append("demo", snap(1000, 12))
    a = store.read("demo")
    b = store.read("demo")
    assert a is b, "second read is served from cache"


def test_cache_invalidated_by_append(store):
    store.append("demo", snap(1000, 12))
    store.append("demo", snap(2000, 34))
    rows = store.read("demo")
    assert len(rows) == 2
    assert rows[1] == {"t": 2000, "tier": "pro", "w5h": 34}


def test_history_row_drops_windows_with_no_pct():
    row = history_row(
        {
            "t": 5,
            "tier": "free",
            "windows": [{"id": "a", "pct": 1}, {"id": "b", "pct": None}],
        }
    )
    assert row == {"t": 5, "tier": "free", "a": 1}


def test_append_persists_full_snapshot_json(store):
    store.append("demo", snap(1000, 12))
    conn = sqlite3.connect(store.usage_path)
    try:
        raw = conn.execute("SELECT row FROM snapshots WHERE provider=? AND t=?", ("demo", 1000)).fetchone()[0]
    finally:
        conn.close()
    saved = json.loads(raw)
    assert saved["windows"][0]["label"] == "5h"
    assert saved["windows"][0]["resets_at"] == "2026-09-07T12:00:00Z"
    assert saved["status"] == "ok"
