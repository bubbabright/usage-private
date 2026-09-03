// Cloudflare Workers AI usage provider plugin — descriptor interface.
//
// Daily neuron quota (like claude's rolling windows, not a spend/credit balance):
// every account gets 10,000 free Neurons/day, reset 00:00 UTC. Above that,
// Workers Paid bills overage at $0.011/1k with no cap — so pct CAN exceed 100
// ("in overage, still billing"); we do NOT clamp the top, only the floor.
//
// Source: the GraphQL Analytics API (single endpoint for all CF analytics),
//   POST https://api.cloudflare.com/client/v4/graphql
//   viewer.accounts(filter:{accountTag}).aiInferenceAdaptiveGroups
// grouped by (date, modelId); sum.totalNeurons per row. Summing today's rows =
// the day's neuron spend; per-model rows become segments. Schema confirmed by
// live introspection 2026-07-23 (sum.totalNeurons, dimensions.date/modelId;
// dataset caps queries at a 4w4d range — we only ever ask for one day).
//
// Auth: a Cloudflare API token as Bearer. The token `wrangler login` mints
// (account:read) is sufficient — no dedicated Analytics scope needed (verified
// live). Daemon reads the token from config; never writes it.
//
// parse() is a PURE function of the GraphQL response JSON text so it unit-tests
// against a vendored real capture with no network.

export const NEURONS_COLOR = '#E69F00'; // Okabe-Ito orange

export const ID = 'cloudflare';
export const LABEL = 'Cloudflare AI';

export const FREE_NEURONS_PER_DAY = 10000;
const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const USER_AGENT = 'usage-daemon/0.1';

// One grouped query for a single UTC day. accountTag + date bound at call time.
const QUERY =
  'query($acct:String!,$d:Date!){viewer{accounts(filter:{accountTag:$acct})' +
  '{aiInferenceAdaptiveGroups(limit:1000,filter:{date_geq:$d,date_leq:$d},orderBy:[date_DESC])' +
  '{count sum{totalNeurons} dimensions{date modelId}}}}}';

export class AuthExpiredError extends Error {
  constructor(msg = 'Cloudflare API token missing or invalid') {
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

// Next 00:00 UTC — the daily neuron quota's fixed reset boundary.
export function nextUtcMidnight(from = new Date()) {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const d = from.getUTCDate();
  return new Date(Date.UTC(y, m, d + 1, 0, 0, 0)).toISOString().replace('.000', '');
}

// Pure function of the GraphQL response JSON text — no fs/network.
export function parse(raw) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AuthExpiredError('unparseable cloudflare graphql response');
  }

  // GraphQL surfaces auth/permission failures in `errors` with data:null.
  if (data?.errors?.length && data?.data == null) {
    const msg = data.errors[0]?.message || 'graphql error';
    if (data.errors[0]?.extensions?.code === 'quota') {
      throw new RateLimitedError();
    }
    throw new AuthExpiredError(`cloudflare graphql: ${msg}`);
  }

  const accounts = data?.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    // No account matched the tag -> bad token/accountTag, treat as auth.
    throw new AuthExpiredError('cloudflare graphql returned no account');
  }

  const groups = accounts[0]?.aiInferenceAdaptiveGroups ?? [];
  // Empty groups is VALID — it means zero AI usage today, not an error.
  let totalNeurons = 0;
  const perModel = new Map();
  for (const g of groups) {
    const n = g?.sum?.totalNeurons;
    if (typeof n === 'number' && Number.isFinite(n)) {
      totalNeurons += n;
      const model = g?.dimensions?.modelId;
      if (model) perModel.set(model, (perModel.get(model) ?? 0) + n);
    }
  }

  // Floor-clamp only: overage past 100% is real signal on Workers Paid.
  const pct = Math.max(0, (100 * totalNeurons) / FREE_NEURONS_PER_DAY);

  const windows = [
    {
      id: 'daily_neurons',
      label: 'Neurons',
      letter: 'Ne',
      pct,
      // Absolute usage alongside pct: neurons are a real countable unit against
      // a hard daily cap (unlike claude/grok utilization %), so clients can show
      // "73 / 10000 neurons" instead of only a percentage.
      used: totalNeurons,
      cap: FREE_NEURONS_PER_DAY,
      unit: 'neurons',
      resets_at: nextUtcMidnight(),
      color: NEURONS_COLOR,
      will_deplete: false,
    },
  ];

  const segments = [...perModel.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([model, neurons]) => ({ model, neurons }));

  return { tier: null, windows, segments };
}

function createProvider() {
  let apiToken = null;
  let accountId = null;

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'token' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://dash.cloudflare.com',
        auth: { kind: 'token' },
        windows: [{ id: 'daily_neurons', label: 'Neurons', color: NEURONS_COLOR }],
        tiers: [],
      };
    },

    configure(cfg = {}) {
      // !== undefined so configure({api_token:''}) can explicitly clear it.
      if (cfg.api_token !== undefined) apiToken = cfg.api_token ? String(cfg.api_token).trim() : null;
      if (cfg.token !== undefined) apiToken = cfg.token ? String(cfg.token).trim() : apiToken;
      if (cfg.account_id) accountId = String(cfg.account_id).trim();
      if (cfg.account_tag) accountId = String(cfg.account_tag).trim();
    },

    async setAuth(payload) {
      apiToken = String(payload ?? '').trim() || null;
    },

    async fetch() {
      if (!apiToken) throw new AuthExpiredError('no Cloudflare API token configured');
      if (!accountId) throw new AuthExpiredError('no Cloudflare account_id configured');

      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
      const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
        body: JSON.stringify({ query: QUERY, variables: { acct: accountId, d: today } }),
      });
      if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
      if (res.status === 429) {
        throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
      }
      if (!res.ok) throw new Error(`api.cloudflare.com HTTP ${res.status}`);
      return res.text();
    },

    intervalSeconds() {
      return 300;
    },

    meta() {
      return {};
    },

    parse,
  };
}

export { createProvider };
