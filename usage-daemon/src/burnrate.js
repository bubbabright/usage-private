// Least-squares burn-rate projection. Mirrors the extensions' slope helper
// (HANDOFF-2) so the daemon computes will_deplete once and the client just
// renders the blink.

// Ordinary least-squares slope of y over x. Returns 0 for <2 points or no spread.
export function slope(points) {
  const n = points.length;
  if (n < 2) return 0;
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

// Project a single window forward from history: is it on track to hit 100%
// before its reset? history rows are {t, <windowId>: pct}. Uses samples within
// the current window (t >= windowStart) so a prior window's data doesn't leak.
export function willDeplete(history, windowId, currentPct, resetsAt, now = Date.now()) {
  if (currentPct == null || !resetsAt) return false;
  if (currentPct >= 100) return false; // already capped, not "will" deplete

  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs) || resetMs <= now) return false;

  const pts = history
    .filter((r) => typeof r[windowId] === 'number')
    .map((r) => [r.t, r[windowId]]);
  if (pts.length < 2) return false;

  const m = slope(pts); // pct per ms
  if (m <= 0) return false; // flat or dropping (a reset) — not depleting

  const projected = currentPct + m * (resetMs - now);
  return projected >= 100;
}
