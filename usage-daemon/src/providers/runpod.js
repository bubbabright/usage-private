// RunPod usage provider plugin — descriptor interface.
//
// RunPod's balance figure is GraphQL-only (no REST equivalent — the REST v2
// billing endpoints only report historical usage line items, not a current
// balance). Confirmed live against a real key (401/invalid-key still
// resolves to a valid field name, HTTP 200) and against the community client
// ashleykleynhans/runpod-api's actual query text:
//
//   POST https://api.runpod.io/graphql?api_key=<key>
//     body: { query: "query myself { myself { clientBalance underBalance minBalance } }" }
//     -> { data: { myself: { clientBalance, underBalance, minBalance } } }
//
// clientBalance is a pay-as-you-go dollar balance, not a used/cap quota — no
// monthly cap or reset date exists. Rendered as a bare-count "balance
// remaining" meter, same fallback shape serpapi.js uses for accounts with no
// fixed plan (used_is_remaining: true, no cap).
//
// parse() is a PURE function of the raw JSON text.

export const BALANCE_COLOR = '#009E73'; // Okabe-Ito green

export const ID = 'runpod';
export const LABEL = 'RunPod';

const GRAPHQL_URL = 'https://api.runpod.io/graphql';
const USER_AGENT = 'usage-daemon/0.1';
const QUERY = 'query myself { myself { clientBalance underBalance minBalance } }';

export class AuthExpiredError extends Error {
  constructor(msg = 'RunPod API key missing or invalid') {
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

// Pure function of the raw JSON text — no fs/network.
export function parse(raw) {
  let env;
  try {
    env = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AuthExpiredError('unparseable RunPod graphql envelope');
  }
  if (!env || typeof env !== 'object') {
    throw new AuthExpiredError('unparseable RunPod graphql envelope');
  }
  if (env.errors) {
    throw new AuthExpiredError(`runpod: ${env.errors[0]?.message || 'graphql error'}`);
  }

  const me = env.data?.myself;
  if (!me || typeof me.clientBalance !== 'number') {
    throw new AuthExpiredError('no usable RunPod balance in graphql response');
  }

  const windows = [
    {
      id: 'balance',
      label: 'Balance',
      letter: 'Bl',
      pct: null, // pay-as-you-go dollar balance, no fixed cap
      used: me.clientBalance,
      used_is_remaining: true,
      unit: 'USD',
      resets_at: null,
      color: BALANCE_COLOR,
      will_deplete: me.underBalance === true,
    },
  ];

  return {
    tier: null,
    windows,
    segments: [],
    // carried out of parse so meta() can surface the raw figures too.
    _runpod: {
      client_balance: me.clientBalance,
      under_balance: me.underBalance ?? null,
      min_balance: typeof me.minBalance === 'number' ? me.minBalance : null,
    },
  };
}

function createProvider() {
  let apiKey = null;
  let lastStats = null; // surfaced via meta()

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'token' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://www.runpod.io/console/user/billing',
        auth: { kind: 'token' },
        category: 'support',
        windows: [{ id: 'balance', label: 'Balance', color: BALANCE_COLOR }],
        tiers: [],
      };
    },

    configure(cfg = {}) {
      // !== undefined so configure({api_key:''}) can explicitly clear it.
      if (cfg.api_key !== undefined) apiKey = cfg.api_key ? String(cfg.api_key).trim() : null;
    },

    async setAuth(payload) {
      apiKey = String(payload ?? '').trim() || null;
    },

    async fetch() {
      if (!apiKey) throw new AuthExpiredError('no RunPod API key configured');

      const res = await fetch(`${GRAPHQL_URL}?api_key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
        body: JSON.stringify({ query: QUERY }),
      });

      if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
      if (res.status === 429) {
        throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
      }
      if (!res.ok) throw new Error(`api.runpod.io HTTP ${res.status}`);

      const body = await res.json();
      if (body?.errors) throw new AuthExpiredError(`runpod: ${body.errors[0]?.message || 'graphql error'}`);
      lastStats = parse(JSON.stringify(body))._runpod;
      return JSON.stringify(body);
    },

    intervalSeconds() {
      return 300;
    },

    meta() {
      return lastStats
        ? {
            client_balance: lastStats.client_balance,
            under_balance: lastStats.under_balance,
            min_balance: lastStats.min_balance,
          }
        : {};
    },

    parse,
  };
}

export { createProvider };
