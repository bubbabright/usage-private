// Context7 usage provider plugin — descriptor interface.
//
// Context7's dashboard stats endpoint
//   GET https://context7.com/api/dashboard/stats/<teamId>
//     -> { success: true, data: { quotaLimit, userRequests, ownerPlan,
//                                  creditBalance, dailyStats: [...] } }
// gives the monthly request quota (quotaLimit) vs requests consumed this
// cycle (userRequests). There is no reset-date field in the payload — the
// window's resets_at is left null.
//
// Auth: browser session cookie for context7.com (cookie kind, same as
// tavily/mistral/ollama). Context7 uses Clerk for auth — its __session JWT
// is extremely short-lived (~60s), so a hand-pasted cookie goes stale almost
// immediately. Use cookie_from_firefox = "context7.com" so the daemon pulls
// a fresh cookie out of Firefox before each poll instead of relying on a
// static paste.
//
// parse() is a PURE function of the envelope JSON text.

export const REQUESTS_COLOR = '#F0E442'; // Okabe-Ito yellow

export const ID = 'context7';
export const LABEL = 'Context7';

const API_URL = 'https://context7.com';
const USER_AGENT = 'usage-daemon/0.1';

export class AuthExpiredError extends Error {
  constructor(msg = 'Context7 session cookie missing or expired') {
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
// envelope: { quotaLimit, userRequests, ownerPlan, creditBalance }
// (the dashboard stats endpoint's `data` object)
export function parse(raw) {
  let env;
  try {
    env = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AuthExpiredError('unparseable context7 envelope');
  }
  if (!env || typeof env !== 'object') {
    throw new AuthExpiredError('unparseable context7 envelope');
  }
  if (env.success !== true || !env.data) {
    throw new AuthExpiredError('context7: not authenticated');
  }

  const data = env.data;
  const consumed = typeof data.userRequests === 'number' ? data.userRequests : null;
  const cap = typeof data.quotaLimit === 'number' ? data.quotaLimit : null;

  if (consumed == null) {
    throw new AuthExpiredError('no usable Context7 request figure in envelope');
  }

  const windows = [
    {
      id: 'requests',
      label: 'Requests/mo',
      letter: 'Rq',
      pct: cap && cap > 0 ? clampPct((100 * consumed) / cap) : null,
      used: cap != null ? Math.max(0, cap - consumed) : null, // remaining, not consumed
      used_is_remaining: true,
      cap,
      unit: 'requests',
      resets_at: null,
      color: REQUESTS_COLOR,
      will_deplete: false,
    },
  ];

  return {
    tier: data.ownerPlan ?? null,
    windows,
    segments: [],
    // carried out of parse so meta() can surface the raw figures too.
    _context7: {
      quotaLimit: cap,
      userRequests: consumed,
      ownerPlan: data.ownerPlan ?? null,
      creditBalance: typeof data.creditBalance === 'number' ? data.creditBalance : null,
    },
  };
}

function createProvider() {
  let cookie = null;
  let teamId = null;
  let lastStats = null; // surfaced via meta()

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'cookie' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://context7.com/dashboard',
        auth: { kind: 'cookie' },
        // Support service (docs/API access), not an AI plan: a metered API
        // that backs the work rather than being the work. Clients render
        // these compactly instead of giving them a full plan card.
        category: 'support',
        windows: [{ id: 'requests', label: 'Requests/mo', color: REQUESTS_COLOR }],
        tiers: [],
      };
    },

    configure(cfg = {}) {
      // !== undefined so configure({cookie:''}) can explicitly clear it.
      if (cfg.cookie !== undefined) cookie = cfg.cookie ? String(cfg.cookie).trim() : null;
      if (cfg.team_id !== undefined) teamId = cfg.team_id ? String(cfg.team_id).trim() : null;
    },

    async fetch() {
      if (!cookie) throw new AuthExpiredError('no Context7 session cookie configured');
      if (!teamId) throw new Error('context7: no team_id configured (see config.example.toml)');

      const res = await fetch(`${API_URL}/api/dashboard/stats/${encodeURIComponent(teamId)}`, {
        headers: {
          Cookie: cookie,
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          Referer: 'https://context7.com/dashboard',
        },
      });

      if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
      if (res.status === 429) {
        throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
      }
      if (!res.ok) throw new Error(`context7.com HTTP ${res.status}`);

      const body = await res.json();
      // Cache figures for meta() (parse() computes them too, but the runner
      // calls meta() independently of parse()).
      lastStats = parse(JSON.stringify(body))._context7;
      return JSON.stringify(body);
    },

    intervalSeconds() {
      return 300;
    },

    meta() {
      return lastStats
        ? {
            quota_limit: lastStats.quotaLimit,
            user_requests: lastStats.userRequests,
            owner_plan: lastStats.ownerPlan,
            credit_balance: lastStats.creditBalance,
          }
        : {};
    },

    parse,
  };
}

export { createProvider };
