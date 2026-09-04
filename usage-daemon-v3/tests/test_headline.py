"""Port of test/headline.test.js (computeHeadline)."""

from usage_daemon.headline import compute_headline

NOW = 1784529600000  # Date.UTC(2026, 6, 20, 12, 0, 0) — 2026-07-20T12:00:00Z


def row(hours_ago, fields):
    return {"t": NOW - int(hours_ago * 3600 * 1000), **fields}


def _w(id, label, pct, color="#E69F00", **extra):
    return {"id": id, "label": label, "pct": pct, "color": color, **extra}


def test_poll_scope_picks_largest_delta_vs_second_to_last_row():
    providers_data = [
        {
            "name": "claude",
            "label": "Claude",
            "current": {"windows": [_w("session", "5h", 12)]},
            "history": [row(1, {"session": 10}), row(0.1, {"session": 11})],  # delta 1
        },
        {
            "name": "mistral",
            "label": "Mistral",
            "current": {"windows": [_w("vibe_monthly", "Vibe", 100)]},
            "history": [row(1, {"vibe_monthly": 40}), row(0.1, {"vibe_monthly": 40})],  # delta 60
        },
    ]
    out = compute_headline(providers_data, NOW)
    assert out["poll"]["provider"] == "mistral"
    assert out["poll"]["delta"] == 60
    assert out["poll"]["from_pct"] == 40
    assert out["poll"]["to_pct"] == 100


def test_24h_scope_finds_last_row_at_or_before_now_minus_24h():
    providers_data = [
        {
            "name": "claude",
            "label": "Claude",
            "current": {"windows": [_w("weekly", "7d", 63, "#56B4E9")]},
            "history": [
                row(30, {"weekly": 20}),
                row(25, {"weekly": 25}),  # last row at/before now-24h -> from_pct 25
                row(10, {"weekly": 50}),
                row(0.1, {"weekly": 62}),
            ],
        },
    ]
    out = compute_headline(providers_data, NOW)
    assert out["24h"]["from_pct"] == 25
    assert out["24h"]["delta"] == 38


def test_window_with_no_history_at_scope_is_skipped_not_crashed():
    providers_data = [
        {
            "name": "fresh",
            "label": "Fresh",
            "current": {"windows": [_w("x", "X", 5, None)]},
            "history": [row(0.1, {"x": 5})],  # only 1 row -> no 24h-ago point
        },
    ]
    out = compute_headline(providers_data, NOW)
    assert out["24h"] is None
    assert out["poll"] is None  # also < 2 rows, no poll-delta either


def test_zero_delta_does_not_win():
    providers_data = [
        {
            "name": "flat",
            "label": "Flat",
            "current": {"windows": [_w("x", "X", 5, None)]},
            "history": [row(1, {"x": 5}), row(0.1, {"x": 5})],
        },
    ]
    out = compute_headline(providers_data, NOW)
    assert out["poll"] is None


def test_depleting_picks_short_window_with_soonest_projected_eta():
    providers_data = [
        {
            "name": "claude",
            "label": "Claude",
            "current": {
                "windows": [
                    {
                        **_w("session", "5h", 80),
                        "will_deplete": True,
                        "resets_at": "2026-07-21T00:00:00Z",
                    }
                ]
            },
            # rising ~10pt/hr -> hits 100 in ~2h
            "history": [row(2, {"session": 60}), row(1, {"session": 70}), row(0.1, {"session": 80})],
        },
        {
            "name": "opencode-go",
            "label": "OpenCode Go",
            "current": {
                "windows": [
                    {
                        **_w("5h", "5 Hour", 90),
                        "will_deplete": True,
                        "resets_at": "2026-07-21T00:00:00Z",
                    }
                ]
            },
            # rising ~20pt/hr -> hits 100 in ~0.5h, sooner than claude's ~2h
            "history": [row(2, {"5h": 50}), row(1, {"5h": 70}), row(0.1, {"5h": 90})],
        },
    ]
    out = compute_headline(providers_data, NOW)
    assert out["depleting"]["provider"] == "opencode-go"


def test_depleting_weekly_monthly_windows_are_excluded():
    providers_data = [
        {
            "name": "claude",
            "label": "Claude",
            "current": {
                "windows": [
                    {
                        **_w("weekly", "7d", 95, "#56B4E9"),
                        "will_deplete": True,
                        "resets_at": "2026-07-25T00:00:00Z",
                    }
                ]
            },
            "history": [row(2, {"weekly": 50}), row(1, {"weekly": 80}), row(0.1, {"weekly": 95})],
        },
    ]
    out = compute_headline(providers_data, NOW)
    assert out["depleting"] is None


def test_depleting_ignores_will_deplete_false():
    providers_data = [
        {
            "name": "claude",
            "label": "Claude",
            "current": {
                "windows": [
                    {
                        **_w("session", "5h", 30),
                        "will_deplete": False,
                        "resets_at": "2026-07-25T00:00:00Z",
                    }
                ]
            },
            "history": [row(2, {"session": 10}), row(1, {"session": 20}), row(0.1, {"session": 30})],
        },
    ]
    out = compute_headline(providers_data, NOW)
    assert out["depleting"] is None


def test_all_scopes_null_when_no_usable_history():
    out = compute_headline([], NOW)
    assert out["poll"] is None
    assert out["12h"] is None
    assert out["24h"] is None


def test_pct_null_windows_are_ignored():
    providers_data = [
        {
            "name": "p",
            "label": "P",
            "current": {"windows": [_w("x", "X", None, None)]},
            "history": [row(1, {"x": 5}), row(0.1, {"x": 10})],
        },
    ]
    out = compute_headline(providers_data, NOW)
    assert out["poll"] is None
