// Deepgram usage provider plugin — descriptor interface.
//
// Deepgram is pay-as-you-go against a PREPAID balance (dollars), not a rolling
// time-window and not a hard daily cap. The headroom that matters is "how many
// dollars are left", so this plugin reads the balances endpoint, not the usage
// breakdown (CodexBar's Deepgram provider deliberately shows usage counts and
// skips balance — opposite choice, because this suite is about live headroom):
//   GET https://api.deepgram.com/v1/projects            (discover projects)
//   GET https://api.deepgram.com/v1/projects/{id}/balances
//     -> { balances: [ { balance_id, amount, units, purchase_order_id } ] }
// amount is remaining USD. Sum across a project's balances (and across all
// visible projects when no project_id is pinned).
//
// A prepaid balance has no reset and no intrinsic ceiling, so pct is only
// meaningful against a user-declared starting credit (`balance_cap` in config).
// Without a cap we still surface the dollar figure via meta() and leave pct
// null (a balance meter, not a percentage bar) — the known "balance meter kind"
// gap, shared with openrouter credits.
//
// Auth: `Authorization: Token <API_KEY>`; the key needs the `usage:read` scope
// for the project. parse() is a PURE function of the envelope JSON text.

export const BALANCE_COLOR = '#009E73'; // Okabe-Ito green

export const ID = 'deepgram';
export const LABEL = 'Deepgram';

const BASE_URL = 'https://api.deepgram.com/v1';
const USER_AGENT = 'usage-daemon/0.1';

export class AuthExpiredError extends Error {
  constructor(msg = 'Deepgram API key missing or invalid') {
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

// Pure function of the envelope JSON text — no fs/network.
// envelope: { balances: [{amount, units}], projects: <int>, cap: <number|null> }
export function parse(raw) {
  let env;
  try {
    env = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AuthExpiredError('unparseable deepgram envelope');
  }
  if (!env || typeof env !== 'object') {
    throw new AuthExpiredError('unparseable deepgram envelope');
  }
  // Deepgram surfaces auth/scope failures as { err_code, err_msg }.
  if (env.err_code) {
    throw new AuthExpiredError(`deepgram: ${env.err_msg || env.err_code}`);
  }
  if (!Array.isArray(env.balances)) {
    throw new AuthExpiredError('deepgram returned no balances');
  }

  let remaining = 0;
  let units = 'USD';
  for (const b of env.balances) {
    if (b && typeof b.amount === 'number' && Number.isFinite(b.amount)) {
      remaining += b.amount;
      if (typeof b.units === 'string' && b.units) units = b.units;
    }
  }

  const cap = typeof env.cap === 'number' && env.cap > 0 ? env.cap : null;
  // Used-% only when the user declared a starting credit; else balance meter.
  const pct = cap != null ? Math.max(0, Math.min(100, (100 * (cap - remaining)) / cap)) : null;

  const windows = [
    {
      id: 'balance',
      label: 'Balance',
      letter: 'Bal',
      pct,
      // The dollars left have to ride on the WINDOW, not just in _balance/meta().
      // Without these the window was {pct: null} and nothing else, so a healthy
      // provider rendered as an empty bar with no number anywhere — status ok,
      // display blank. used_is_remaining marks `used` as "what's left" rather
      // than "what's been consumed", which is the whole point of a balance.
      used: remaining,
      used_is_remaining: true,
      cap,
      unit: units,
      resets_at: null, // prepaid balance, no reset
      color: BALANCE_COLOR,
      will_deplete: false,
    },
  ];

  return {
    tier: null,
    windows,
    segments: [],
    // carried out of parse so meta() can surface the dollar figure even when
    // pct is null (the runner reads meta() separately from parse()).
    _balance: { amount: remaining, units, projects: env.projects ?? null },
  };
}

function createProvider() {
  let apiKey = null;
  let projectId = null;
  let cap = null;
  let lastBalance = null; // { amount, units } — surfaced via meta()

  async function get(url) {
    return fetch(url, {
      headers: {
        Authorization: `Token ${apiKey}`,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
  }

  function guard(res, who) {
    if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
    if (res.status === 429) {
      throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
    }
    if (!res.ok) throw new Error(`${who} HTTP ${res.status}`);
  }

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'token' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://console.deepgram.com',
        auth: { kind: 'token' },
        // Support service (speech-to-text), not an AI plan: a metered API that
        // backs the work rather than being the work. Clients render these
        // compactly instead of giving them a full plan card.
        category: 'support',
        windows: [{ id: 'balance', label: 'Balance', color: BALANCE_COLOR }],
        tiers: [],
      };
    },

    configure(cfg = {}) {
      // !== undefined so configure({api_key:''}) can explicitly clear it.
      if (cfg.api_key !== undefined) apiKey = cfg.api_key ? String(cfg.api_key).trim() : null;
      if (cfg.project_id) projectId = String(cfg.project_id).trim();
      if (cfg.balance_cap !== undefined) {
        const n = Number(cfg.balance_cap);
        cap = Number.isFinite(n) && n > 0 ? n : null;
      }
    },

    async setAuth(payload) {
      apiKey = String(payload ?? '').trim() || null;
    },

    async fetch() {
      if (!apiKey) throw new AuthExpiredError('no Deepgram API key configured');

      // Resolve which projects to query.
      let projectIds;
      if (projectId) {
        projectIds = [projectId];
      } else {
        const res = await get(`${BASE_URL}/projects`);
        guard(res, 'api.deepgram.com/projects');
        const body = await res.json();
        projectIds = (body?.projects ?? [])
          .map((p) => p?.project_id)
          .filter(Boolean);
        if (projectIds.length === 0) {
          throw new AuthExpiredError('Deepgram key sees no projects');
        }
      }

      // Sum balances across every project.
      const balances = [];
      for (const id of projectIds) {
        const res = await get(`${BASE_URL}/projects/${id}/balances`);
        guard(res, 'api.deepgram.com/balances');
        const body = await res.json();
        if (Array.isArray(body?.balances)) balances.push(...body.balances);
      }

      const envelope = { balances, projects: projectIds.length, cap };
      // Cache the dollar figure for meta() (parse() computes it too, but the
      // runner calls meta() independently of parse()).
      const parsed = parse(JSON.stringify(envelope));
      lastBalance = parsed._balance;
      return JSON.stringify(envelope);
    },

    intervalSeconds() {
      return 300;
    },

    meta() {
      return lastBalance
        ? { balance_usd: lastBalance.amount, balance_units: lastBalance.units }
        : {};
    },

    parse,
  };
}

export { createProvider };
