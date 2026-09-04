"""Least-squares burn-rate projection (port of src/burnrate.js).

Computes will_deplete once in the runner; the client just renders the blink.
"""

from __future__ import annotations

from typing import Sequence

from .timeutil import to_host_iso


def slope(points: Sequence[tuple[float, float]]) -> float:
    """Ordinary least-squares slope of y over x. 0 for <2 points or no spread."""
    n = len(points)
    if n < 2:
        return 0.0
    sx = sy = sxx = sxy = 0.0
    for x, y in points:
        sx += x
        sy += y
        sxx += x * x
        sxy += x * y
    denom = n * sxx - sx * sx
    if denom == 0:
        return 0.0
    return (n * sxy - sx * sy) / denom


def _resets_at_ms(resets_at, now_ms: int) -> int | None:
    """Parse resets_at (ISO string or epoch) to epoch ms; None if unusable.

    The runner passes resets_at through to_host_iso() already, so this handles
    the host-local ISO form (plus raw epoch ints for direct callers)."""
    if resets_at is None:
        return None
    if isinstance(resets_at, (int, float)) and not isinstance(resets_at, bool):
        # JS Date.parse works on epoch ms; treat numbers equal to Date.parse's
        # output (ms) only when huge, else seconds.
        try:
            v = float(resets_at)
        except Exception:
            return None
        return int(v if abs(v) > 1e12 else v * 1000)
    s = str(resets_at)
    from datetime import datetime

    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None
    return int(dt.timestamp() * 1000)


def will_deplete(history, window_id: str, current_pct, resets_at, now: int | None = None) -> bool:
    """Project a window: on track to hit 100% before its reset?"""
    import time as _time

    if now is None:
        now = int(_time.time() * 1000)
    if current_pct is None or not resets_at:
        return False
    if current_pct >= 100:
        return False  # already capped, not "will" deplete

    reset_ms = _resets_at_ms(resets_at, now)
    if reset_ms is None or reset_ms <= now:
        return False

    pts = [(r["t"], r[window_id]) for r in history if isinstance(r.get(window_id), (int, float))]
    if len(pts) < 2:
        return False

    m = slope(pts)  # pct per ms
    if m <= 0:
        return False  # flat or dropping (a reset) — not depleting

    projected = current_pct + m * (reset_ms - now)
    return projected >= 100


# Re-export to_host_iso so callers that want the ISO rendering can share it.
__all__ = ["slope", "will_deplete"]