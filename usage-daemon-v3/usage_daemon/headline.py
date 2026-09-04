"""Biggest-mover headline (port of src/headline.js).

Scans every provider's current windows against its own history and picks the
single largest |delta| per time scope, plus a dedicated 'depleting' entry for a
SHORT window projected to run out before its reset.

Pure function of assembled {name, label, current, history} data so it
unit-tests against fixtures directly.
"""

from __future__ import annotations

import time as _time

from .burnrate import slope
from .history_utils import find_value_at_or_before

_SCOPES = {
    "poll": None,  # compare to second-to-last history row
    "12h": 12 * 3600 * 1000,
    "24h": 24 * 3600 * 1000,
}


def _is_short_window(w) -> bool:
    s = f"{w.get('id')} {w.get('label') or ''}".lower()
    return not ("week" in s or "month" in s)


def _projected_eta_ms(history, w, now) -> float | None:
    pts = [
        (r["t"], r[w["id"]])
        for r in (history or [])
        if isinstance(r.get(w["id"]), (int, float))
    ]
    if len(pts) < 2:
        return None
    m = slope(pts)
    if m <= 0:
        return None
    return (100 - w["pct"]) / m


def _find_poll_from(history, window_id: str):
    if not history or len(history) < 2:
        return None
    prev = history[-2]
    v = prev.get(window_id)
    return v if isinstance(v, (int, float)) else None


def compute_headline(providers_data, now: int | None = None):
    """providers_data: list of {name, label, current, history}."""
    if now is None:
        now = int(_time.time() * 1000)
    result: dict = {}

    for scope_name, ms in _SCOPES.items():
        biggest = None
        for pd in providers_data:
            current = pd.get("current")
            if not current or not current.get("windows"):
                continue
            for w in current["windows"]:
                if not isinstance(w.get("pct"), (int, float)):
                    continue
                from_pct = (
                    _find_poll_from(pd.get("history"), w["id"])
                    if ms is None
                    else find_value_at_or_before(pd.get("history"), w["id"], now - ms)
                )
                if not isinstance(from_pct, (int, float)):
                    continue
                delta = float(w["pct"]) - float(from_pct)
                if delta == 0:
                    continue
                if biggest is None or abs(delta) > abs(biggest["delta"]):
                    biggest = {
                        "provider": pd.get("name"),
                        "provider_label": pd.get("label") or pd.get("name"),
                        "window_id": w["id"],
                        "window_label": w.get("label") or w["id"],
                        "color": w.get("color"),
                        "from_pct": from_pct,
                        "to_pct": w["pct"],
                        "delta": delta,
                    }
        result[scope_name] = biggest

    depleting = None
    for pd in providers_data:
        current = pd.get("current")
        if not current or not current.get("windows"):
            continue
        for w in current["windows"]:
            if not w.get("will_deplete"):
                continue
            if not isinstance(w.get("pct"), (int, float)):
                continue
            if not _is_short_window(w):
                continue
            eta_ms = _projected_eta_ms(pd.get("history"), w, now)
            if eta_ms is None:
                continue
            if depleting is None or eta_ms < depleting["eta_ms"]:
                depleting = {
                    "provider": pd.get("name"),
                    "provider_label": pd.get("label") or pd.get("name"),
                    "window_id": w["id"],
                    "window_label": w.get("label") or w["id"],
                    "color": w.get("color"),
                    "pct": w["pct"],
                    "resets_at": w.get("resets_at"),
                    "eta_ms": eta_ms,
                }
    result["depleting"] = depleting

    return result