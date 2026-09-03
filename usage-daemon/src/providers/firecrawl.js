// Firecrawl usage provider plugin — descriptor interface.
//
// Firecrawl bills monthly credits against a plan allotment. The usage endpoint
//   GET https://api.firecrawl.dev/v2/team/credit-usage
//     -> { data: { remainingCredits, planCredits,
//                  billingPeriodStart, billingPeriodEnd } }
// gives remaining credits + the per-cycle plan size.
//
// `planCredits` is NOT a hard ceiling — unused credits roll over, so remaining
// routinely exceeds one cycle's plan (e.g. 8056 banked on a 1000/mo plan =
// 8 full cycles + 56). A flat used-% against total remaining would barely move.
// Instead the meter treats remaining as a stack of plan-sized slices and shows
// progress through the CURRENT slice: pct = used within this 1000-credit slice
// (0 = fresh slice, 100 = about to roll). Every 1000 credits spent is a full
// 0->100 sweep that resets from the rollover balance — constant activity. The
// absolute figure (remaining) and full runway (cycles_remaining) ride along on
// the window / meta so clients can show "8056 credits · 8 cycles left".
//
// Auth: `Authorization: Bearer <API_KEY>` (a static firecrawl.dev API key,
// no OAuth expiry). parse() is a PURE function of the envelope JSON text.

export const CREDITS_COLOR = '#0072B2'; // Okabe-Ito blue

export const ID = 'firecrawl';
export const LABEL = 'Firecrawl';

const DEFAULT_API_URL = 'https://api.firecrawl.dev';
const CREDIT_USAGE_PATH = '/v2/team/credit-usage';
const USER_AGENT = 'usage-daemon/0.1';

export class AuthExpiredError extends Error {
  constructor(msg = 'Firecrawl API key missing or invalid') {
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

// Split a remaining-credits balance into whole plan-sized cycles + the credits
// left in the current (partial) slice. At an exact boundary the current slice
// is treated as a FULL slice (just rolled), so the bar reads fresh, not empty.
//   remaining=8056, plan=1000 -> { cycles: 8, sliceRemaining: 56 }
//   remaining=8000, plan=1000 -> { cycles: 8, sliceRemaining: 1000 } (just rolled)
export function sliceCredits(remaining, plan) {
  const m = ((remaining % plan) + plan) % plan;
  const sliceRemaining = m === 0 && remaining > 0 ? plan : m;
  const cycles = Math.floor(remaining / plan);
  return { cycles, sliceRemaining };
}

// Pure function of the envelope JSON text — no fs/network.
// envelope: { remaining_credits, plan_credits, period_start, period_end }
export function parse(raw) {
  let env;
  try {
    env = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AuthExpiredError('unparseable firecrawl envelope');
  }
  if (!env || typeof env !== 'object') {
    throw new AuthExpiredError('unparseable firecrawl envelope');
  }
  // Firecrawl surfaces auth/scope failures as { error } / { success:false }.
  if (env.error || env.success === false) {
    throw new AuthExpiredError(`firecrawl: ${env.error || 'request rejected'}`);
  }

  const remaining = env.remaining_credits;
  const plan = env.plan_credits;
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) {
    throw new AuthExpiredError('no usable Firecrawl credit figures in envelope');
  }

  // No bar for Firecrawl — remaining credits routinely exceed one plan cycle
  // via rollover, so a slice-based pct (e.g. 94% through the current 1000-credit
  // slice when 56 of 8056 remain) looks like "almost out" when you're actually
  // not. The real signal is the raw count + cycles banked, not a bar.
  let pct = null;
  let cyclesRemaining = null;
  let sliceRemaining = null;
  if (typeof plan === 'number' && plan > 0) {
    const s = sliceCredits(remaining, plan);
    cyclesRemaining = s.cycles;
    sliceRemaining = s.sliceRemaining;
  }

  // Always surface billingPeriodEnd, banked cycles or not: even with a
  // rollover buffer, the +plan top-up on that date is useful for planning
  // ("will I have enough before the next 1000 lands") — hiding it just
  // because the buffer hasn't run dry yet was withholding a real answer to
  // a real question.
  const resetsAt = env.period_end ?? null;

  const windows = [
    {
      id: 'credits',
      label: 'Credits',
      letter: 'Cr',
      pct,
      used: remaining, // absolute balance so clients can show "N credits"
      used_is_remaining: true, // `used` above IS the remaining balance, not consumption against `cap` (cap is one slice, not a ceiling — remaining routinely exceeds it via rollover)
      cap: typeof plan === 'number' && plan > 0 ? plan : null, // one slice
      unit: 'credits',
      cycles_remaining: cyclesRemaining, // whole plan-sized cycles banked beyond the current slice
      resets_at: resetsAt,
      color: CREDITS_COLOR,
      will_deplete: false,
    },
  ];

  return {
    tier: null,
    windows,
    segments: [],
    // carried out of parse so meta() can surface the raw figures too.
    _credits: {
      remaining,
      plan: typeof plan === 'number' && Number.isFinite(plan) ? plan : null,
      cycles_remaining: cyclesRemaining,
      slice_remaining: sliceRemaining,
      period_start: env.period_start ?? null,
      period_end: env.period_end ?? null,
    },
  };
}

function createProvider() {
  let apiKey = null;
  let apiUrl = DEFAULT_API_URL;
  let lastCredits = null; // surfaced via meta()

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'token' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://www.firecrawl.dev/app/usage',
        auth: { kind: 'token' },
        // Support service (web scraping), not an AI plan: a metered API that
        // backs the work rather than being the work. Clients render these
        // compactly instead of giving them a full plan card.
        category: 'support',
        windows: [{ id: 'credits', label: 'Credits', color: CREDITS_COLOR }],
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
      if (!apiKey) throw new AuthExpiredError('no Firecrawl API key configured');

      const res = await fetch(apiUrl + CREDIT_USAGE_PATH, {
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
      if (!res.ok) throw new Error(`api.firecrawl.dev HTTP ${res.status}`);

      const body = await res.json();
      const cfg = body?.data ?? body ?? {};
      const envelope = {
        remaining_credits: typeof cfg.remainingCredits === 'number' ? cfg.remainingCredits : null,
        plan_credits: typeof cfg.planCredits === 'number' ? cfg.planCredits : null,
        period_start: cfg.billingPeriodStart ?? null,
        period_end: cfg.billingPeriodEnd ?? null,
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
            credits_remaining: lastCredits.remaining,
            plan_credits: lastCredits.plan,
            cycles_remaining: lastCredits.cycles_remaining,
          }
        : {};
    },

    parse,
  };
}

export { createProvider };
