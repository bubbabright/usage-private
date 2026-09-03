// Tavily usage provider plugin — descriptor interface.
//
// Tavily bills monthly search credits against a plan limit. The account endpoint
//   GET https://app.tavily.com/api/account
//     -> { usage, limit, last_reset, current_plan, plan_display_name, ... }
// gives credits used this cycle vs the plan cap, with a monthly reset date.
//
// Auth: browser session cookie for app.tavily.com (cookie kind, same as ollama
// and mistral). parse() is a PURE function of the envelope JSON text.

export const CREDITS_COLOR = '#D55E00'; // Okabe-Ito vermillion

export const ID = 'tavily';
export const LABEL = 'Tavily';

const API_URL = 'https://app.tavily.com';
const ACCOUNT_PATH = '/api/account';
const USER_AGENT = 'usage-daemon/0.1';

export class AuthExpiredError extends Error {
  constructor(msg = 'Tavily session cookie missing or expired') {
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
// envelope: { usage, limit, last_reset, current_plan, plan_display_name }
export function parse(raw) {
  let env;
  try {
    env = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AuthExpiredError('unparseable tavily envelope');
  }
  if (!env || typeof env !== 'object') {
    throw new AuthExpiredError('unparseable tavily envelope');
  }
  // Tavily surfaces auth failures as empty shell or error signals.
  if (env.error || env.success === false) {
    throw new AuthExpiredError(`tavily: ${env.error || 'request rejected'}`);
  }

  const usage = typeof env.usage === 'number' ? env.usage : null;
  const limit = typeof env.limit === 'number' ? env.limit : null;

  if (usage == null) {
    throw new AuthExpiredError('no usable Tavily usage figure in envelope');
  }

  const remaining = limit != null ? limit - usage : null;
  const pct = limit != null && limit > 0 ? clampPct((usage / limit) * 100) : null;
  const resetsAt = env.last_reset ?? null;

  const windows = [
    {
      id: 'credits',
      label: 'Credits',
      letter: 'Cr',
      pct,
      used: remaining,
      used_is_remaining: true,
      cap: limit,
      unit: 'searches',
      resets_at: resetsAt,
      color: CREDITS_COLOR,
      will_deplete: false,
    },
  ];

  return {
    tier: env.current_plan ?? null,
    windows,
    segments: [],
    // carried out of parse so meta() can surface the raw figures too.
    _credits: {
      usage,
      limit,
      plan: env.current_plan ?? null,
      plan_display_name: env.plan_display_name ?? null,
      last_reset: env.last_reset ?? null,
    },
  };
}

function createProvider() {
  let cookie = null;
  let lastCredits = null; // surfaced via meta()

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'cookie' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://app.tavily.com/billing',
        auth: { kind: 'cookie' },
        // Support service (web search), not an AI plan: a metered API that
        // backs the work rather than being the work. Clients render these
        // compactly instead of giving them a full plan card.
        category: 'support',
        windows: [{ id: 'credits', label: 'Credits', color: CREDITS_COLOR }],
        tiers: [],
      };
    },

    configure(cfg = {}) {
      // !== undefined so configure({cookie:''}) can explicitly clear it.
      if (cfg.cookie !== undefined) cookie = cfg.cookie ? String(cfg.cookie).trim() : null;
    },

    async fetch() {
      if (!cookie) throw new AuthExpiredError('no Tavily session cookie configured');

      const res = await fetch(API_URL + ACCOUNT_PATH, {
        headers: {
          Cookie: cookie,
          'User-Agent': USER_AGENT,
          Accept: '*/*',
        },
      });

      if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
      if (res.status === 429) {
        throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
      }
      if (!res.ok) throw new Error(`app.tavily.com HTTP ${res.status}`);

      const body = await res.json();
      const envelope = {
        usage: typeof body.usage === 'number' ? body.usage : null,
        limit: typeof body.limit === 'number' ? body.limit : null,
        last_reset: body.last_reset ?? null,
        current_plan: body.current_plan ?? null,
        plan_display_name: body.plan_display_name ?? null,
      };
      // Cache figures for meta() (parse() computes them too, but the runner
      // calls meta() independently of parse()).
      const parsed = parse(JSON.stringify(envelope));
      lastCredits = parsed._credits;
      return JSON.stringify(envelope);
    },

    intervalSeconds() {
      return 300;
    },

    meta() {
      return lastCredits
        ? {
            usage: lastCredits.usage,
            limit: lastCredits.limit,
            plan: lastCredits.plan,
          }
        : {};
    },

    parse,
  };
}

export { createProvider };