"""Port of test/history-utils.test.js."""

import pytest

from usage_daemon.history_utils import find_activity_base, find_value_at_or_before

T = lambda mins: mins * 60 * 1000  # noqa: E731  minutes -> ms, readable fixtures


def test_find_value_at_or_before_picks_latest_row_at_or_before_target():
    history = [
        {"t": 0, "w": 10},
        {"t": T(10), "w": 20},
        {"t": T(20), "w": 30},
    ]
    assert find_value_at_or_before(history, "w", T(15)) == 20
    assert find_value_at_or_before(history, "w", T(20)) == 30
    assert find_value_at_or_before(history, "w", -1) is None  # before all history


def test_find_value_at_or_before_empty_or_missing_history():
    assert find_value_at_or_before([], "w", 100) is None
    assert find_value_at_or_before(None, "w", 100) is None


def test_activity_base_no_reset_in_window_plain_cutoff_lookup():
    # now=70min, window=60min -> cutoff=10min. Latest row at-or-before cutoff is t=8 (w=18).
    now = T(70)
    history = [
        {"t": T(0), "w": 10},
        {"t": T(8), "w": 18},  # at-or-before cutoff (10min) -> candidate
        {"t": T(40), "w": 40},
        {"t": T(65), "w": 65},
    ]
    base = find_activity_base(history, "w", now, T(60))
    assert base["value"] == 18
    assert base["t"] == now - T(60)


def test_activity_base_reset_within_window_overrides_stale_candidate():
    # now=70min, window=60min (cutoff=10min). Reset 80->0 at 45min is inside the
    # window: "last hour, or since reset, whichever is shorter" starts at the reset.
    now = T(70)
    history = [
        {"t": T(0), "w": 60},
        {"t": T(20), "w": 70},  # pre-cutoff candidate, overridden by the reset
        {"t": T(40), "w": 80},
        {"t": T(45), "w": 0},  # reset: 80 -> 0
        {"t": T(55), "w": 5},
        {"t": T(65), "w": 15},
    ]
    base = find_activity_base(history, "w", now, T(60))
    assert base["value"] == 0
    assert base["t"] == T(45)


def test_activity_base_reset_before_window_is_ignored():
    now = T(100)
    history = [
        {"t": T(0), "w": 80},
        {"t": T(10), "w": 0},  # reset before cutoff (now-60=T(40)) -> ignored
        {"t": T(30), "w": 20},
        {"t": T(50), "w": 40},
        {"t": T(60), "w": 55},
    ]
    # cutoff = T(40); latest row at-or-before cutoff is t=T(30), w=20
    base = find_activity_base(history, "w", now, T(60))
    assert base["value"] == 20
    assert base["t"] == T(40)


def test_activity_base_multiple_resets_uses_most_recent():
    now = T(70)
    history = [
        {"t": T(0), "w": 50},
        {"t": T(15), "w": 0},  # first reset within window
        {"t": T(30), "w": 90},
        {"t": T(35), "w": 0},  # second, more recent reset
        {"t": T(50), "w": 20},
    ]
    base = find_activity_base(history, "w", now, T(60))
    assert base["value"] == 0
    assert base["t"] == T(35)


def test_activity_base_no_history_at_all():
    assert find_activity_base([], "w", T(70), T(60)) is None
    assert find_activity_base(None, "w", T(70), T(60)) is None


def test_activity_base_only_stale_pre_cutoff_row_falls_back():
    now = T(200)
    history = [{"t": T(0), "w": 10}]  # long before cutoff (T(140)), no reset in window
    base = find_activity_base(history, "w", now, T(60))
    assert base["value"] == 10
    assert base["t"] == now - T(60)
