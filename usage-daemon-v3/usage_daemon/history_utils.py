"""Shared history-lookback helpers (port of src/history-utils.js).

history rows are {t, tier, <windowId>: pct}, oldest -> newest (see
sqlite_store.history_row). Both headline's fixed-scope movers and the runner's
rolling activity delta (pct_1h_ago) need "what was this window's pct as of T
ago", just with different T.
"""

from __future__ import annotations

from typing import Any


def find_value_at_or_before(history, window_id: str, target_t: int):
    """pct at-or-before target_t, or None."""
    if not history:
        return None
    candidate = None
    for row in history:
        if row["t"] <= target_t:
            candidate = row
        else:
            break
    if candidate is None or not isinstance(candidate.get(window_id), (int, float)):
        return None
    return candidate[window_id]


def find_activity_base(history, window_id: str, now: int, window_ms: int):
    """Base pct for an 'activity in last windowMs' comparison.

    Normally at-or-before `now - windowMs`, but if the window RESET partway
    through the lookback (pct dropped), use the last reset row instead — i.e.
    "last windowMs, or since reset, whichever is shorter". Returns None if
    there's nothing usable.
    """
    if not history:
        return None
    cutoff = now - window_ms

    prev_val = None
    last_reset_row = None
    pre_cutoff_candidate = None

    for row in history:
        if row["t"] > now:
            break
        val = row.get(window_id)
        if not isinstance(val, (int, float)):
            continue
        # A drop from the prior row is a reset; only ones landing AFTER cutoff
        # matter (an earlier reset is excluded by the at-or-before lookup).
        if row["t"] > cutoff and prev_val is not None and val < prev_val:
            last_reset_row = row
        if row["t"] <= cutoff:
            pre_cutoff_candidate = row
        prev_val = val

    if last_reset_row is not None:
        return {"value": last_reset_row[window_id], "t": last_reset_row["t"]}
    if pre_cutoff_candidate is not None and isinstance(
        pre_cutoff_candidate.get(window_id), (int, float)
    ):
        return {"value": pre_cutoff_candidate[window_id], "t": cutoff}
    return None