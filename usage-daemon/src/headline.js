// "Biggest mover" headline — scans every provider's current windows against
// their own history and picks the single largest |delta| per time scope, so
// the web UI can show one pinned bar across all providers/windows instead of
// making the user click through each provider tab to notice a big jump.
//
// Also surfaces a "depleting" entry: a SHORT window (5h/session-scale) that's
// projected to run out before its reset. Weekly/monthly windows are excluded
// here on purpose — those are slow-moving by nature and already visible via
// the poll/12h/24h movers above (a monthly window jumping 20pts in 12h is
// itself a "biggest mover" candidate), so re-flagging them as "depleting"
// would just be the same signal twice. Short windows are the ones that
// actually bite you day-to-day with no other warning, so they get the
// dedicated slot.
//
// Pure function of the assembled {name, label, current, history} data (no
// fetch/runner access in here) so it unit-tests against fixtures directly —
// same convention as every provider's parse().

import { slope } from './burnrate.js';
import { findValueAtOrBefore } from './history-utils.js';

const SCOPES = {
  poll: null, // compare to the second-to-last history row, not a fixed ms window
  '12h': 12 * 3600 * 1000,
  '24h': 24 * 3600 * 1000,
};

function isShortWindow(w) {
  const s = `${w.id} ${w.label || ''}`.toLowerCase();
  return !/week|month/.test(s);
}

function projectedEtaMs(history, w, now) {
  const pts = (history || [])
    .filter((r) => typeof r[w.id] === 'number')
    .map((r) => [r.t, r[w.id]]);
  if (pts.length < 2) return null;
  const m = slope(pts);
  if (m <= 0) return null;
  return (100 - w.pct) / m;
}

function findPollFrom(history, windowId) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const prev = history[history.length - 2];
  return typeof prev?.[windowId] === 'number' ? prev[windowId] : null;
}

export function computeHeadline(providersData, now = Date.now()) {
  const result = {};

  for (const [scopeName, ms] of Object.entries(SCOPES)) {
    let biggest = null;

    for (const { name, label, current, history } of providersData) {
      if (!current?.windows?.length) continue;

      for (const w of current.windows) {
        if (typeof w.pct !== 'number') continue;

        const fromPct = ms === null
          ? findPollFrom(history, w.id)
          : findValueAtOrBefore(history, w.id, now - ms);
        if (typeof fromPct !== 'number') continue;

        const delta = w.pct - fromPct;
        if (delta === 0) continue;
        if (!biggest || Math.abs(delta) > Math.abs(biggest.delta)) {
          biggest = {
            provider: name,
            provider_label: label || name,
            window_id: w.id,
            window_label: w.label || w.id,
            color: w.color ?? null,
            from_pct: fromPct,
            to_pct: w.pct,
            delta,
          };
        }
      }
    }

    result[scopeName] = biggest;
  }

  let depleting = null;
  for (const { name, label, current, history } of providersData) {
    if (!current?.windows?.length) continue;
    for (const w of current.windows) {
      if (!w.will_deplete || typeof w.pct !== 'number' || !isShortWindow(w)) continue;
      const etaMs = projectedEtaMs(history, w, now);
      if (etaMs == null) continue;
      if (!depleting || etaMs < depleting.eta_ms) {
        depleting = {
          provider: name,
          provider_label: label || name,
          window_id: w.id,
          window_label: w.label || w.id,
          color: w.color ?? null,
          pct: w.pct,
          resets_at: w.resets_at ?? null,
          eta_ms: etaMs,
        };
      }
    }
  }
  result.depleting = depleting;

  return result;
}
