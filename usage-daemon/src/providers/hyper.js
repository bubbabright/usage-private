// Charm Hyper credits provider plugin.
//
// Two sources:
//   1. GET /v1/credits (Bearer API key) — returns {"balance": 78}
//   2. Billing page HTML (cookie) — parses "Next Hypercredit Refresh in 4 weeks"
//      to compute resets_at. Optional: if no cookie, resets_at is null.
//
// Free tier: 100 credits/month (hardcoded — API doesn't return cap).
// Used = cap - balance.

export const CREDITS_COLOR = '#0072B2'; // Okabe-Ito blue

export const ID = 'hyper';
export const LABEL = 'Charm Hyper';

const API_URL = 'https://hyper.charm.land/v1/credits';
const BILLING_URL = 'https://hyper.charm.land/teams/6b4e808f-3933-4bfd-a321-be1bcfe04f21/billing';
const USER_AGENT = 'usage-daemon/0.1';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0';

const PLAN_CAP = 100; // free tier: 100 credits/month

export class AuthExpiredError extends Error {
  constructor(msg = 'Hyper API key missing or invalid') {
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

// Parse "Next Hypercredit Refresh in 4 weeks" / "in 1 day" / "in 2 days"
// into an ISO timestamp. Returns null on failure.
export function parseRefreshText(html) {
  const m = html.match(/Next Hypercredit Refresh in (\d+)\s+(day|days|week|weeks)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  let ms;
  if (unit.startsWith('week')) {
    ms = n * 7 * 24 * 3600 * 1000;
  } else {
    ms = n * 24 * 3600 * 1000;
  }
  return new Date(Date.now() + ms).toISOString();
}

// Pure function of the raw API JSON text — no fs/network.
export function parse(raw) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AuthExpiredError('unparseable hyper response');
  }
  if (!data || typeof data !== 'object') {
    throw new AuthExpiredError('unparseable hyper response');
  }

  // Auth failures surface as { error: { message, type } }.
  if (data.error) {
    if (data.error.type === 'authentication_error') {
      throw new AuthExpiredError(data.error.message || 'invalid hyper API key');
    }
    throw new Error(`hyper API error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  const balance = data.balance;

  if (typeof balance !== 'number' || !Number.isFinite(balance)) {
    throw new AuthExpiredError('no usable hypercredits balance');
  }

  const used = Math.max(0, PLAN_CAP - balance);
  const pct = Math.max(0, Math.min(100, (100 * used) / PLAN_CAP));

  const windows = [
    {
      id: 'hypercredits',
      label: 'Credits',
      letter: 'Hc',
      pct,
      used,
      cap: PLAN_CAP,
      unit: 'credits',
      resets_at: null, // filled in by fetch() if billing page is reachable
      color: CREDITS_COLOR,
      will_deplete: false,
    },
  ];

  return {
    tier: 'free',
    windows,
    segments: [],
    // Raw balance for meta() — lets the UI show "78 remaining".
    _hyper: { balance },
  };
}

function createProvider() {
  let apiKey = null;
  let cookie = null;

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'token' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://hyper.charm.land/docs/api/credits.html#pricing',
        auth: { kind: 'token' },
        windows: [{ id: 'hypercredits', label: 'Credits', color: CREDITS_COLOR }],
        tiers: ['free', 'shred'],
      };
    },

    configure(cfg = {}) {
      if (cfg.api_key !== undefined) apiKey = cfg.api_key ? String(cfg.api_key).trim() : null;
      if (cfg.api_token !== undefined) apiKey = cfg.api_token ? String(cfg.api_token).trim() : null;
      if (cfg.token !== undefined) apiKey = cfg.token ? String(cfg.token).trim() : apiKey;
      // Cookie for the billing page (refresh date scrape). Optional.
      if (cfg.cookie !== undefined) cookie = cfg.cookie;
    },

    async setAuth(payload) {
      apiKey = String(payload ?? '').trim() || null;
    },

    async fetch() {
      if (!apiKey) throw new AuthExpiredError('no hyper API key configured');

      const res = await fetch(API_URL, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
      });

      if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
      if (res.status === 429) {
        throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
      }
      if (!res.ok) throw new Error(`hyper.charm.land HTTP ${res.status}`);

      const text = await res.text();
      const parsed = parse(text);

      // Best-effort: fetch the billing page to get the refresh date.
      if (cookie) {
        try {
          const billRes = await fetch(BILLING_URL, {
            headers: {
              Cookie: cookie,
              'User-Agent': BROWSER_UA,
              Accept: 'text/html',
            },
            redirect: 'manual',
            signal: AbortSignal.timeout(5000),
          });
          if (billRes.ok) {
            const billHtml = await billRes.text();
            const resetsAt = parseRefreshText(billHtml);
            if (resetsAt && parsed.windows?.[0]) {
              parsed.windows[0].resets_at = resetsAt;
            }
          }
        } catch {
          // billing page fetch is best-effort — resets_at stays null
        }
      }

      return text;
    },

    intervalSeconds() {
      return 300;
    },

    parse,
  };
}

export { createProvider };