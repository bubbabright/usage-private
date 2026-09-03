// Mistral usage provider plugin — descriptor interface (HANDOFF-20).
//
// Three meters, one poll:
//   - vibe_monthly (required path): free-tier Vibe Code usage via cookie
//     tRPC GET admin.mistral.ai/api/local-trpc/billing.budget. This is the
//     THIRD endpoint this meter has used: the original billing.vibeUsage
//     (bare usage_percentage) was retired 2026-07; its replacement
//     billing.usageLimits (a dollar-cap meter, result.data.json.limits.
//     completion) is still reachable but as of 2026-08-16 reliably returns
//     zeroed-out data (confirmed live) — silently wrong, not an auth error,
//     so this provider was showing a stale/dead meter with no error to
//     surface it. billing.budget (same admin.mistral.ai host, same cookie,
//     same non-batched local-trpc URL shape) is the current working source,
//     confirmed live 2026-08-16:
//       result.data.json.vibe_budget = {
//         usage_percentage, // 0-100, ready-made — no used/cap math needed
//         initial_budget,   // $ cap (informational; not used for pct)
//         currency,
//         reset_at,         // ISO 8601, direct passthrough
//         payg_enabled,     // true = pay-as-you-go/uncapped account
//       }
//   - api_monthly (bonus, same call, same cookie, no admin key needed):
//     result.data.json.api_budget, same shape as vibe_budget — free-tier
//     included API usage. Independent of the optional Admin-key
//     monthly_spend window below (different scope: personal included-usage
//     vs. org-wide billed spend).
//   - monthly_spend (optional): Admin-role API key
//     GET console.mistral.ai/api/admin/usage  ÷  /admin/spend-limit
//
// parse() is a PURE function of a combined envelope string
//   { vibe, usage, spend_limit }  // each field raw JSON text or null
// so it unit-tests against fixtures with no network/fs. fetch() assembles the
// envelope. Cookie write is only via POST /usage/mistral/cookie (runner).
// Never write Admin keys or Mistral credential files.

export const VIBE_COLOR = '#E69F00';  // Okabe-Ito orange
export const API_COLOR = '#009E73';   // Okabe-Ito green
export const SPEND_COLOR = '#56B4E9'; // Okabe-Ito blue

export const ID = 'mistral';
export const LABEL = 'Mistral';

const VIBE_INPUT = JSON.stringify({
  json: null,
  meta: { values: ['undefined'], v: 1 },
});
const VIBE_URL =
  'https://admin.mistral.ai/api/local-trpc/billing.budget?input=' +
  encodeURIComponent(VIBE_INPUT);
const ADMIN_BASE = 'https://console.mistral.ai/api/admin';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) usage-daemon/0.1';

// Category keys documented / observed on the usage dashboard.
const SPEND_CATEGORY_KEYS = [
  'chat',
  'completion',
  'ocr',
  'audio',
  'connectors',
  'libraries_api',
  'libraries',
  'fine_tuning',
  'vibe_usage',
  'vibe',
];

export class AuthExpiredError extends Error {
  constructor(msg = 'Mistral session expired or missing credentials') {
    super(msg);
    this.code = 'auth_expired';
  }
}

export class RateLimitedError extends Error {
  constructor(retryAfter = null) {
    super('rate_limited');
    this.code = 'rate_limited';
    this.retryAfter = retryAfter;
  }
}

// First of next calendar month, UTC (Vibe + spend both reset this way).
export function nextMonthStartUtc(from = new Date()) {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  return new Date(Date.UTC(y, m + 1, 1, 0, 0, 0)).toISOString().replace('.000', '');
}

// Vibe-only backoff: once the monthly meter reads 100%, re-polling every
// base interval just re-confirms "still maxed" until the real reset — back
// off to at most `capSeconds` per hop (re-armed repeatedly by
// intervalSeconds() until the real reset) so a reset up to ~31 days out
// doesn't need a delay past Node's ~24.8-day setTimeout ceiling in one hop.
// Worst case the display shows a stale 100% for up to `capSeconds` after the
// real reset — a non-issue for a background usage meter.
export function vibeIntervalSeconds(
  pct,
  resetAtIso,
  now = new Date(),
  { base = 300, capSeconds = 24 * 3600 } = {},
) {
  if (pct !== 100 || !resetAtIso) return base;
  const resetMs = Date.parse(resetAtIso);
  if (Number.isNaN(resetMs)) return base;
  const secondsUntilReset = Math.floor((resetMs - now.getTime()) / 1000);
  if (secondsUntilReset <= 0) return base; // clock skew / just-past-reset: repoll promptly
  return Math.min(secondsUntilReset, capSeconds);
}

// Pull the billing.budget payload out of the tRPC envelope:
// result.data.json (tolerate an already-unwrapped shape).
function budgetPayload(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return obj?.result?.data?.json ?? obj?.data?.json ?? obj;
}

// A single { usage_percentage, reset_at, payg_enabled } budget leg → window
// fields. Clamps pct 0-100; falls back to nextMonthStartUtc() if resetAt is
// missing/malformed (matches the old dollar-meter's derived reset).
function budgetWindow(budget) {
  if (!budget || !Number.isFinite(budget.usage_percentage)) return null;
  const pct = Math.max(0, Math.min(100, budget.usage_percentage));
  const resetAt =
    typeof budget.reset_at === 'string' && !Number.isNaN(Date.parse(budget.reset_at))
      ? budget.reset_at
      : nextMonthStartUtc();
  return { pct, resetAt, paygEnabled: Boolean(budget.payg_enabled) };
}

// Sum $ spend from Admin /usage body. Tolerant of total field or category map.
export function extractSpendTotal(usage) {
  if (!usage || typeof usage !== 'object') return null;

  for (const k of ['total', 'total_cost', 'total_amount', 'amount', 'usage']) {
    const v = usage[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v && typeof v === 'object' && typeof v.amount === 'number') return v.amount;
    if (v && typeof v === 'object' && typeof v.total === 'number') return v.total;
  }

  let sum = 0;
  let found = false;
  for (const k of SPEND_CATEGORY_KEYS) {
    const v = usage[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v;
      found = true;
    } else if (v && typeof v === 'object') {
      const n = v.amount ?? v.cost ?? v.total ?? v.usd;
      if (typeof n === 'number' && Number.isFinite(n)) {
        sum += n;
        found = true;
      }
    }
  }
  if (found) return sum;

  // Nested { costs: { completion: 1.2, ... } } style
  const costs = usage.costs || usage.breakdown || usage.categories;
  if (costs && typeof costs === 'object') {
    let s = 0;
    let n = 0;
    for (const v of Object.values(costs)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        s += v;
        n++;
      } else if (v && typeof v === 'object') {
        const x = v.amount ?? v.cost ?? v.total;
        if (typeof x === 'number' && Number.isFinite(x)) {
          s += x;
          n++;
        }
      }
    }
    if (n) return s;
  }

  return null;
}

function periodEndFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  for (const k of [
    'end',
    'period_end',
    'billing_period_end',
    'periodEnd',
    'end_date',
  ]) {
    if (typeof usage[k] === 'string' && usage[k]) return usage[k];
  }
  // month/year → first of next month
  const month = usage.month ?? usage.Month;
  const year = usage.year ?? usage.Year;
  if (typeof month === 'number' && typeof year === 'number') {
    // API months are 1-based
    return new Date(Date.UTC(year, month, 1, 0, 0, 0))
      .toISOString()
      .replace('.000', '');
  }
  return null;
}

// Pure function of the envelope JSON text — no fs/network.
export function parse(raw) {
  let envelope;
  try {
    envelope = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AuthExpiredError('unparseable mistral envelope');
  }
  if (!envelope || typeof envelope !== 'object') {
    throw new AuthExpiredError('unparseable mistral envelope');
  }

  const windows = [];
  let tier = null;
  let vibeOk = false;
  let spendOk = false;

  // --- vibe_monthly (+ bonus api_monthly, same call/cookie) ---
  let vibeCache = null; // { pct, resetAt } for fetch()'s intervalSeconds cache
  if (envelope.vibe) {
    let vibeRaw;
    try {
      vibeRaw =
        typeof envelope.vibe === 'string'
          ? JSON.parse(envelope.vibe)
          : envelope.vibe;
    } catch {
      vibeRaw = null;
    }
    const body = budgetPayload(vibeRaw);

    const vibe = budgetWindow(body?.vibe_budget);
    if (vibe) {
      windows.push({
        id: 'vibe_monthly',
        label: 'Vibe',
        letter: 'Vb',
        pct: vibe.pct,
        resets_at: vibe.resetAt,
        color: VIBE_COLOR,
        will_deplete: false,
      });
      vibeOk = true;
      vibeCache = { pct: vibe.pct, resetAt: vibe.resetAt };
      // Free-tier: a $10 cap with payg_enabled=false is the free plan;
      // PAYG accounts flip payg_enabled true.
      if (!vibe.paygEnabled) tier = 'free';
    }

    const api = budgetWindow(body?.api_budget);
    if (api) {
      windows.push({
        id: 'api_monthly',
        label: 'API',
        letter: 'Ap',
        pct: api.pct,
        resets_at: api.resetAt,
        color: API_COLOR,
        will_deplete: false,
      });
    }
  }

  // --- monthly_spend (optional; needs both legs) ---
  if (envelope.usage && envelope.spend_limit) {
    let usageObj;
    let limitObj;
    try {
      usageObj =
        typeof envelope.usage === 'string'
          ? JSON.parse(envelope.usage)
          : envelope.usage;
      limitObj =
        typeof envelope.spend_limit === 'string'
          ? JSON.parse(envelope.spend_limit)
          : envelope.spend_limit;
    } catch {
      usageObj = null;
      limitObj = null;
    }

    if (usageObj && limitObj && typeof limitObj === 'object') {
      const spend = extractSpendTotal(usageObj);
      const noLimit = Boolean(limitObj.no_monthly_limit);
      const cap =
        typeof limitObj.amount === 'number'
          ? limitObj.amount
          : typeof limitObj.limit === 'number'
            ? limitObj.limit
            : null;

      let pct = null;
      if (!noLimit && cap != null && cap > 0 && spend != null) {
        pct = (100 * spend) / cap;
      } else if (!noLimit && cap != null && cap > 0 && spend === null) {
        // Cap known but spend unreadable → still emit window with null pct
        pct = null;
      } else if (noLimit) {
        pct = null;
      }

      // Emit window whenever spend-limit parsed (optional meter present).
      windows.push({
        id: 'monthly_spend',
        label: 'Spend',
        letter: '$',
        pct,
        resets_at: periodEndFromUsage(usageObj) ?? nextMonthStartUtc(),
        color: SPEND_COLOR,
        will_deplete: false,
      });
      spendOk = true;
    }
  }

  if (!vibeOk && !spendOk) {
    throw new AuthExpiredError(
      'no usable Mistral meter (cookie vibe and/or Admin spend failed)',
    );
  }

  return { tier, windows, segments: [], _vibe: vibeCache };
}

function createProvider() {
  let cookie = null;
  let adminKey = null;
  let lastVibePct = null;
  let lastVibeResetAt = null;

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'cookie' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://console.mistral.ai/usage',
        auth: { kind: 'cookie' },
        windows: [
          { id: 'vibe_monthly', label: 'Vibe', color: VIBE_COLOR },
          { id: 'api_monthly', label: 'API', color: API_COLOR },
          { id: 'monthly_spend', label: 'Spend', color: SPEND_COLOR },
        ],
        tiers: ['free'],
      };
    },

    configure(cfg = {}) {
      // !== undefined (not truthy) so configure({cookie:''}) can explicitly
      // clear it — a flush action, not just "no change was requested".
      if (cfg.cookie !== undefined) cookie = cfg.cookie;
      if (cfg.admin_key) adminKey = String(cfg.admin_key).trim();
      if (cfg.adminKey) adminKey = String(cfg.adminKey).trim();
    },

    async fetch() {
      let vibe = null;
      let usage = null;
      let spend_limit = null;
      let vibeAuthFailed = false;
      let vibeRateLimited = null;
      let vibeStatus = null; // real HTTP status / network-error text, for diagnosis
      let spendAuthFailed = false;
      let spendRateLimited = null;
      let hadAdminAttempt = false;

      // --- Vibe (cookie) ---
      if (cookie) {
        try {
          const res = await fetch(VIBE_URL, {
            headers: {
              Cookie: cookie,
              'User-Agent': USER_AGENT,
              Accept: 'application/json',
            },
            redirect: 'manual',
          });
          vibeStatus = `HTTP ${res.status}`;
          if (res.status >= 300 && res.status < 400) {
            // redirect:'manual' means a 3xx here is Mistral bouncing an expired
            // cookie to login — treat as auth, but keep the status (and where it
            // pointed) so it's explicit, not a blanket "any redirect = auth".
            const location = res.headers.get('location');
            vibeStatus = `HTTP ${res.status}${location ? ` -> ${location}` : ''}`;
            vibeAuthFailed = true;
          } else if (res.status === 401 || res.status === 403) {
            vibeAuthFailed = true;
          } else if (res.status === 429) {
            vibeRateLimited =
              Number(res.headers.get('retry-after')) || null;
          } else if (res.ok) {
            vibe = await res.text();
          }
          // other HTTP errors: leave vibe null (soft) — vibeStatus carries why
        } catch (err) {
          // network — soft fail; may still have spend. Keep the message.
          vibeStatus = `network error: ${err?.message ?? String(err)}`;
        }
      } else {
        vibeAuthFailed = true;
      }

      // --- Admin spend (optional key) ---
      if (adminKey) {
        hadAdminAttempt = true;
        const headers = {
          'x-api-key': adminKey,
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        };
        const now = new Date();
        const month = now.getUTCMonth() + 1;
        const year = now.getUTCFullYear();
        const usageUrl = `${ADMIN_BASE}/usage?month=${month}&year=${year}`;
        const limitUrl = `${ADMIN_BASE}/spend-limit`;

        try {
          const [usageRes, limitRes] = await Promise.all([
            fetch(usageUrl, { headers }),
            fetch(limitUrl, { headers }),
          ]);

          if (usageRes.status === 401 || usageRes.status === 403 ||
              limitRes.status === 401 || limitRes.status === 403) {
            spendAuthFailed = true;
          } else if (usageRes.status === 429 || limitRes.status === 429) {
            spendRateLimited =
              Number(
                usageRes.headers.get('retry-after') ||
                  limitRes.headers.get('retry-after'),
              ) || null;
          } else {
            if (usageRes.ok) usage = await usageRes.text();
            if (limitRes.ok) spend_limit = await limitRes.text();
          }
        } catch {
          // soft — vibe may still work
        }
      }

      // Prefer rate-limit signal if that's all we got
      if (!vibe && !usage && !spend_limit) {
        if (vibeRateLimited != null || spendRateLimited != null) {
          throw new RateLimitedError(vibeRateLimited ?? spendRateLimited);
        }
        // Both paths failed auth (or no admin key and cookie dead)
        if (vibeAuthFailed && (!hadAdminAttempt || spendAuthFailed)) {
          throw new AuthExpiredError(
            cookie
              ? `Mistral cookie rejected (vibe ${vibeStatus ?? 'no response'})` +
                ' and Admin spend unavailable'
              : 'no Mistral cookie configured',
          );
        }
        // Not classified as auth/rate-limit but still no data — surface the real
        // status so a retired endpoint / 5xx / network error is diagnosable
        // instead of the old dead-end "produced no meter data".
        throw new AuthExpiredError(
          `Mistral vibe fetch produced no meter data (${vibeStatus ?? 'no request made'})`,
        );
      }

      const envelope = JSON.stringify({ vibe, usage, spend_limit });
      try {
        const parsed = parse(envelope);
        if (parsed._vibe) {
          lastVibePct = parsed._vibe.pct;
          lastVibeResetAt = parsed._vibe.resetAt;
        }
      } catch {
        // soft — the runner's own parse(raw) call raises the real error for
        // this poll; don't let cache-priming crash fetch()
      }
      return envelope;
    },

    intervalSeconds() {
      if (adminKey) return 300; // monthly_spend needs its own cadence
      return vibeIntervalSeconds(lastVibePct, lastVibeResetAt);
    },

    meta() {
      return {};
    },

    parse,
  };
}

export { createProvider };
