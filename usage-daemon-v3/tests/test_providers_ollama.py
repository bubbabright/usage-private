"""Port of test/ollama.test.js — parse() against the vendored settings fixture."""

import re
from pathlib import Path

import pytest

from usage_daemon.burnrate import slope, will_deplete
from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.ollama import parse

FIXTURE = Path(__file__).parent / "fixtures" / "ollama-settings.html"
html = FIXTURE.read_text(encoding="utf-8")


def test_parse_tier_from_capitalize_pill():
    assert parse(html)["tier"] == "free"


def test_parse_session_and_weekly_windows_at_zero():
    windows = parse(html)["windows"]
    session = next(w for w in windows if w["id"] == "session")
    weekly = next(w for w in windows if w["id"] == "weekly")
    assert session["pct"] == 0
    assert session["resets_at"] == "2026-07-11T10:00:00Z"
    assert session["color"] == "#E69F00"
    assert weekly["pct"] == 0
    assert weekly["resets_at"] == "2026-07-13T00:00:00Z"
    assert weekly["color"] == "#56B4E9"


def test_parse_no_segments_at_zero_usage():
    assert parse(html)["segments"] == []


def test_parse_decimal_pct():
    snippet = """
    <div>Cloud usage <span class="capitalize">free</span></div>
    <div aria-label="Session usage 0% used" data-time="2026-07-12T01:00:00Z"></div>
    <div aria-label="Weekly usage 0.4% used" data-time="2026-07-13T00:00:00Z"></div>"""
    windows = parse(snippet)["windows"]
    assert next(w for w in windows if w["id"] == "session")["pct"] == 0
    assert next(w for w in windows if w["id"] == "weekly")["pct"] == 0.4


def test_parse_segments_when_usage_positive():
    snippet = (
        'Cloud usage <span class="capitalize">free</span>\n'
        '    <div data-usage-segment data-model="nemotron-3-nano:30b" data-requests="9"></div>'
    )
    assert parse(snippet)["segments"] == [{"model": "nemotron-3-nano:30b", "requests": 9}]


def test_parse_logged_out_raises_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse("<html><body>please sign in</body></html>")


def test_burnrate_slope_of_clean_line():
    assert slope([(0, 0), (1, 2), (2, 4)]) == 2


def test_will_deplete_true_when_projected_past_100_before_reset():
    now = 1_000_000
    reset = "1970-01-01T00:16:50Z"  # now + 10_000 ms, epoch 1_010_000
    history = [
        {"t": now - 4000, "session": 30},
        {"t": now - 3000, "session": 35},
        {"t": now - 2000, "session": 40},
        {"t": now - 1000, "session": 45},
        {"t": now, "session": 50},
    ]
    assert will_deplete(history, "session", 50, reset, now) is True


def test_will_deplete_false_when_flat():
    now = 1_000_000
    reset = "1970-01-01T00:16:50Z"
    history = [
        {"t": now - 2000, "session": 20},
        {"t": now - 1000, "session": 20},
        {"t": now, "session": 20},
    ]
    assert will_deplete(history, "session", 20, reset, now) is False
