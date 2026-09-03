// Shared history-lookback helper: given a provider's persisted poll history
// (oldest -> newest rows, see store.js historyRow/append), find a window's
// pct value at or before a target timestamp. Used both by headline.js's
// fixed-scope movers (12h/24h) and runner.js's rolling activity delta
// (pct_1h_ago) — both need "what was this window's pct as of T ago", just
// with different T.
export function findValueAtOrBefore(history, windowId, targetT) {
  if (!Array.isArray(history) || !history.length) return null;
  let candidate = null;
  for (const row of history) {
    if (row.t <= targetT) candidate = row;
    else break;
  }
  if (!candidate || typeof candidate[windowId] !== 'number') return null;
  return candidate[windowId];
}

// Base point for a "activity in the last `windowMs`" comparison — normally
// that's just the value at-or-before `now - windowMs` (findValueAtOrBefore).
// But a window that RESET partway through that lookback (pct dropped, e.g.
// Claude's 5h session rolling from 80% back to 0%) makes that comparison
// meaningless — "70% an hour ago, 15% now" reads as usage going DOWN, when
// really a fresh cycle started. Rather than nulling the comparison out
// entirely in that case (leaving the activity bar flat even though the
// window was genuinely busy), use whichever is more recent: `now - windowMs`
// or the window's last reset within that span — i.e. "last hour, or since
// reset, whichever is shorter." Returns null if there's nothing usable.
export function findActivityBase(history, windowId, now, windowMs) {
  if (!Array.isArray(history) || !history.length) return null;
  const cutoff = now - windowMs;

  let prevVal = null;
  let lastResetRow = null;
  let preCutoffCandidate = null;

  for (const row of history) {
    if (row.t > now) break;
    const val = row[windowId];
    if (typeof val !== 'number') continue;

    // A drop from the prior row is a reset. Only ones that land AFTER cutoff
    // matter here — an earlier reset is already excluded by the normal
    // at-or-before-cutoff lookup below.
    if (row.t > cutoff && prevVal != null && val < prevVal) {
      lastResetRow = row;
    }
    if (row.t <= cutoff) preCutoffCandidate = row;
    prevVal = val;
  }

  if (lastResetRow) return { value: lastResetRow[windowId], t: lastResetRow.t };
  if (preCutoffCandidate && typeof preCutoffCandidate[windowId] === 'number') {
    return { value: preCutoffCandidate[windowId], t: cutoff };
  }
  return null;
}
