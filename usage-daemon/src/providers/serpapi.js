// SerpApi usage provider plugin — descriptor interface.
//
// SerpApi's Account API (GET https://serpapi.com/account.json) reports the
// monthly plan meter: searches_per_month (plan cap), this_month_usage
// (consumed), plan_searches_left, and plan_renewal_date. The call is free —
// it never counts against the monthly quota — so polling every 5m costs
// nothing.
//
// Auth is a query param (`?api_key=...`), not a Bearer header. Accounts
// without an active monthly plan (enterprise credit pools, cancelled
// subscriptions) return a null plan_renewal_date and no monthly figures; for
// those, total_searches_left (remaining credits incl. extra_credits) is
// surfaced as a bare-count meter instead.
//
// parse() is a PURE function of the envelope JSON text.

export const SEARCHES_COLOR = '#E69F00'; // Okabe-Ito orange

export const ID = 'serpapi';
export const LABEL = 'SerpApi';

const DEFAULT_API_URL = 'https://serpapi.com';
const ACCOUNT_PATH = '/account.json';
const USER_AGENT = 'usage-daemon/0.1';

export class AuthExpiredError extends Error {
  constructor(msg = 'SerpApi API key missing or invalid') {
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

function clampPct(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

// Pure function of the envelope JSON text — no fs/network.
// envelope is the raw Account API body (already snake_case):
//   { searches_per_month, this_month_usage, plan_searches_left,
//     total_searches_left, extra_credits, plan_renewal_date }
export function parse(raw) {
  let env;
  try {
    env = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AuthExpiredError('unparseable serpapi envelope');
  }
  if (!env || typeof env !== 'object') {
    throw new AuthExpiredError('unparseable serpapi envelope');
  }
  // SerpApi surfaces auth failures as a 4xx body: { error, error_code }.
  if (env.error) {
    throw new AuthExpiredError(`serpapi: ${env.error}`);
  }

  const windows = [];

  const plan = env.searches_per_month;
  const used = env.this_month_usage;
  const left = env.plan_searches_left;
  if (typeof plan === 'number' && plan > 0 && typeof used === 'number' && Number.isFinite(used)) {
    windows.push({
      id: 'monthly_searches',
      label: 'Searches/mo',
      letter: 'Sr',
      pct: clampPct(100 * (used / plan)), // consumed fraction of this month's plan
      used: typeof left === 'number' && Number.isFinite(left) ? left : Math.max(0, plan - used), // remaining count
      used_is_remaining: true,
      cap: plan,
      unit: 'searches',
      resets_at: env.plan_renewal_date ?? null,
      color: SEARCHES_COLOR,
      will_deplete: false,
    });
  }

  // No monthly plan (credit pool / cancelled) -> bare-count meter on the
  // remaining-credit figure instead of a used-% window.
  const totalLeft = env.total_searches_left;
  if (windows.length === 0 && typeof totalLeft === 'number' && Number.isFinite(totalLeft)) {
    windows.push({
      id: 'total_searches',
      label: 'Searches left',
      letter: 'Sr',
      pct: null,
      used: totalLeft, // absolute balance, not consumption against `cap`
      used_is_remaining: true,
      unit: 'searches',
      resets_at: null,
      color: SEARCHES_COLOR,
      will_deplete: false,
    });
  }

  if (windows.length === 0) {
    throw new AuthExpiredError('no usable SerpApi account figures in envelope');
  }

  return {
    tier: null,
    windows,
    segments: [],
    // carried out of parse so meta() can surface the raw figures too.
    _serpapi: {
      plan: typeof plan === 'number' && Number.isFinite(plan) ? plan : null,
      plan_searches_left: typeof env.plan_searches_left === 'number' ? env.plan_searches_left : null,
      this_month_usage: typeof used === 'number' && Number.isFinite(used) ? used : null,
      total_searches_left: totalLeft != null && Number.isFinite(totalLeft) ? totalLeft : null,
      extra_credits: typeof env.extra_credits === 'number' ? env.extra_credits : null,
      plan_renewal_date: env.plan_renewal_date ?? null,
      plan_monthly_price: typeof env.plan_monthly_price === 'number' ? env.plan_monthly_price : null,
    },
  };
}

function createProvider() {
  let apiKey = null;
  let apiUrl = DEFAULT_API_URL;
  let lastAccount = null; // surfaced via meta()

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'token' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://serpapi.com/account',
        auth: { kind: 'token' },
        // Support service (search results), not an AI plan: a metered API that
        // backs the work rather than being the work. Clients render these
        // compactly instead of giving them a full plan card.
        category: 'support',
        windows: [{ id: 'monthly_searches', label: 'Searches/mo', color: SEARCHES_COLOR }],
        tiers: [],
      };
    },

    configure(cfg = {}) {
      // !== undefined so configure({api_key:''}) can explicitly clear it.
      if (cfg.api_key !== undefined) apiKey = cfg.api_key ? String(cfg.api_key).trim() : null;
      if (cfg.api_url) apiUrl = String(cfg.api_url).trim().replace(/\/+$/, '');
    },

    async setAuth(payload) {
      apiKey = String(payload ?? '').trim() || null;
    },

    async fetch() {
      if (!apiKey) throw new AuthExpiredError('no SerpApi API key configured');

      const res = await fetch(`${apiUrl}${ACCOUNT_PATH}?api_key=${encodeURIComponent(apiKey)}`, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
      });

      if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
      if (res.status === 429) {
        throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
      }
      if (!res.ok) throw new Error(`serpapi.com HTTP ${res.status}`);

      const body = await res.json();
      if (body?.error) throw new AuthExpiredError(`serpapi: ${body.error}`);
      // Cache figures for meta() (parse() computes them too, but the runner
      // calls meta() independently of parse()).
      lastAccount = parse(JSON.stringify(body))._serpapi;
      return JSON.stringify(body);
    },

    intervalSeconds() {
      // Account API is free — no quota burn, so poll at the default cadence.
      return 300;
    },

    meta() {
      return lastAccount
        ? {
            searches_per_month: lastAccount.plan,
            plan_searches_left: lastAccount.plan_searches_left,
            this_month_usage: lastAccount.this_month_usage,
            total_searches_left: lastAccount.total_searches_left,
            extra_credits: lastAccount.extra_credits,
            plan_renewal_date: lastAccount.plan_renewal_date,
          }
        : {};
    },

    parse,
  };
}

export { createProvider };