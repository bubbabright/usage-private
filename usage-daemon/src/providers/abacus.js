// Abacus.ai ChatLLM compute point usage provider plugin.
//
// Compute points from the _getCompleteUserInfo API. Auth is the browser session
// cookie (same as ollama/mistral). Values are in centi-credits (100x); parse()
// divides by 100 for display (verified against the site's own "Total: 2,000"
// panel on 2026-08-27: raw currMonthAvailPoints=200000, freeTierTotal=200000).
//
// Single meter: compute_points — currMonthUsage / currMonthAvailPoints.
// Free tier is a one-time bucket (does not refresh): resets_at carries the
// bucket EXPIRY (freeTierExpiresAt), not a refresh — the UI's countdown reads
// as time left until the credits vanish.

export const CREDITS_COLOR = '#CC79A7'; // Okabe-Ito pink

export const ID = 'abacus';
export const LABEL = 'Abacus.AI';

const API_URL = 'https://apps.abacus.ai/api/v1/_getCompleteUserInfo';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0';

export class AuthExpiredError extends Error {
  constructor(msg = 'Abacus.AI session expired') {
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

// Pure function of the raw API JSON text — no fs/network.
export function parse(raw) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AuthExpiredError('unparseable abacus response');
  }
  if (!data || typeof data !== 'object') {
    throw new AuthExpiredError('unparseable abacus response');
  }

  // API always returns { success, result } — auth failures redirect, not JSON.
  if (!data.success) {
    throw new AuthExpiredError('abacus API returned unsuccessful');
  }

  const org = data.result?.userInfo?.organization;
  if (!org) {
    throw new AuthExpiredError('no organization info in abacus response');
  }

  const cpi = org.computePointInfo;
  const tier = org.subscriptionTier ?? 'unknown';
  const isFreeTier = org.info?.is_free_tier ?? false;

  if (!cpi || typeof cpi.currMonthAvailPoints !== 'number' || typeof cpi.currMonthUsage !== 'number') {
    throw new AuthExpiredError('no usable compute point figures in abacus response');
  }

  // Raw values are centi-credits (100x real credits) — verified live
  // 2026-08-27: API said 200000/200001 while the site panel said
  // Total 2,000 / Used 2,000. Divide by 100 so the UI shows real credits.
  const used = cpi.currMonthUsage / 100;        // real credits consumed
  const cap = cpi.currMonthAvailPoints / 100;   // real credits total
  const pct = cap > 0 ? Math.max(0, Math.min(100, (100 * used) / cap)) : 0;

  // Free tier credits don't refresh — it's a one-time bucket with a hard
  // expiry. Surface that date as resets_at so the UI's countdown shows time
  // left until the bucket vanishes (e.g. "⏱ 11d"); expires_at repeats it
  // explicitly for clients that want to label it "expires" not "resets".
  const resetsAt = cpi.freeTierExpiresAt ?? null;

  const windows = [
    {
      id: 'compute_points',
      label: 'Credits',
      letter: 'Cr',
      pct,
      used,              // consumed credits (real units, already ÷100)
      cap,               // total credits
      unit: 'credits',
      resets_at: resetsAt,
      expires_at: resetsAt,
      color: CREDITS_COLOR,
      will_deplete: false,
      ...(isFreeTier ? { note: 'Free-tier credits — one-time grant, does not refresh' } : {}),
    },
  ];

  return {
    tier,
    windows,
    segments: [],
    // Surface raw figures for meta() — lets the UI show remaining alongside bar.
    _abacus: {
      used: cpi.currMonthUsage,        // raw centi-credits, unconverted
      cap: cpi.currMonthAvailPoints,
      is_free_tier: isFreeTier,
      free_tier_expires: cpi.freeTierExpiresAt ?? null,
    },
  };
}

function createProvider() {
  let cookie = null;

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'cookie' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://apps.abacus.ai/chatllm/admin/profile',
        auth: { kind: 'cookie' },
        windows: [{ id: 'compute_points', label: 'Credits', color: CREDITS_COLOR }],
        tiers: ['free', 'pro', 'max', 'enterprise'],
      };
    },

    configure(cfg = {}) {
      // !== undefined so configure({cookie:''}) can explicitly clear it.
      if (cfg.cookie !== undefined) cookie = cfg.cookie;
    },

    async fetch() {
      if (!cookie) throw new AuthExpiredError('no abacus cookie configured');

      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          'Content-Type': 'application/json',
          'REAI-UI': '1',
          'X-Abacus-Org-Host': 'apps',
        },
        body: JSON.stringify({ isDesktop: true }),
        redirect: 'manual',
      });

      // 3xx redirect = logged out.
      if (res.status >= 300 && res.status < 400) throw new AuthExpiredError();
      if (res.status === 429) {
        throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
      }
      if (!res.ok) throw new Error(`apps.abacus.ai HTTP ${res.status}`);

      return res.text();
    },

    intervalSeconds() {
      return 300;
    },

    parse,
  };
}

export { createProvider };