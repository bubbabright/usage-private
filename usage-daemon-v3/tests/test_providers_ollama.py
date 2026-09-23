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


def test_parse_usage_window_with_data():
    windows = parse(html)["windows"]
    usage = next(w for w in windows if w["id"] == "usage")
    assert usage["label"] == "Free usage"
    assert usage["pct"] == 9.5
    assert usage["resets_at"] == "2026-07-11T10:00:00Z"
    assert usage["color"] == "#E69F00"


def test_parse_segments_in_fixture():
    segments = parse(html)["segments"]
    assert len(segments) == 6
    assert segments[0] == {"model": "nemotron-3-ultra", "requests": 10}
    assert segments[-1] == {"model": "gpt-oss:120b", "requests": 49}


def test_parse_decimal_pct():
    snippet = """
    <div>Included usage <span class="capitalize">free</span></div>
    <div aria-label="Free usage 0.4% used" data-time="2026-07-13T00:00:00Z">Resets in 1 day.</div>"""
    windows = parse(snippet)["windows"]
    assert next(w for w in windows if w["id"] == "usage")["pct"] == 0.4


def test_parse_segments_when_usage_positive():
    snippet = (
        'Included usage <span class="capitalize">free</span>\n'
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
