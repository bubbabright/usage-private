// Cohere usage provider plugin — descriptor interface.
//
// Cohere's public API has no usage/quota endpoint (confirmed: /check-api-key
// only validates key identity). The dashboard.cohere.com "Usage" tab calls an
// internal RPC instead:
//
//   POST https://production.api.os.cohere.com/rpc/BlobheartAPI/GetAPIUsage
//     Authorization: Bearer <dashboard session JWT>
//     body: { req: { orgID, before, after, includeTotal: true } }
//     -> { usages: [{ productID, productName, productUnit, quantity, time, total }] }
//
// This is a per-model/per-day token ledger, NOT a used/cap quota — Cohere's
// documented trial limit ("1,000 API calls a month", docs.cohere.com/docs/
// rate-limits) is a call COUNT, but this endpoint only reports token
// quantities, so there's no way to derive "X of 1000 calls" from it. The
// window below is informational only: total input+output tokens summed over
// a trailing 30-day span, no cap, no pct, no resets_at.
//
// Auth: the Bearer token is a dashboard SESSION JWT pulled from browser
// storage (sessionStorage/localStorage), not a cookie — cookiejar.js only
// reads cookies.sqlite, so cookie_from_firefox CANNOT recover this one. It
// must be pasted manually (auth kind 'token') and re-pasted when it expires
// (observed lifespan ~5 days: exp - iat). org_id is not secret — it's the
// orgID visible in the same dashboard session/network calls.
//
// parse() is a PURE function of the envelope JSON text.

export const TOKENS_COLOR = '#D55E00'; // Okabe-Ito vermillion

export const ID = 'cohere';
export const LABEL = 'Cohere';

const USAGE_URL = 'https://production.api.os.cohere.com/rpc/BlobheartAPI/GetAPIUsage';
const USER_AGENT = 'usage-daemon/0.1';
const WINDOW_DAYS = 30;

export class AuthExpiredError extends Error {
  constructor(msg = 'Cohere dashboard session token missing or expired') {
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
// envelope: { usages: [{ productUnit, quantity, ... }] }
export function parse(raw) {
  let env;
  try {
    env = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AuthExpiredError('unparseable cohere usage envelope');
  }
  if (!env || typeof env !== 'object' || !Array.isArray(env.usages)) {
    throw new AuthExpiredError('unparseable cohere usage envelope');
  }

  let inputTokens = 0;
  let outputTokens = 0;
  for (const u of env.usages) {
    const qty = typeof u.quantity === 'number' ? u.quantity : 0;
    if (u.productUnit === 'Input tokens') inputTokens += qty;
    else if (u.productUnit === 'Output tokens') outputTokens += qty;
  }
  const totalTokens = inputTokens + outputTokens;

  const windows = [
    {
      id: 'tokens',
      label: `Tokens (${WINDOW_DAYS}d)`,
      letter: 'Tk',
      pct: null, // no documented cap for token volume — informational only
      used: totalTokens,
      cap: null,
      unit: 'tokens',
      resets_at: null, // rolling window, not a billing-cycle reset
      color: TOKENS_COLOR,
      will_deplete: false,
    },
  ];

  return {
    tier: null,
    windows,
    segments: [],
    // carried out of parse so meta() can surface the raw figures too.
    _cohere: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens },
  };
}

function createProvider() {
  let token = null;
  let orgId = null;
  let lastStats = null; // surfaced via meta()

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'token' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://dashboard.cohere.com/usage',
        // path/relogin: the pasted value is a short-lived dashboard session
        // JWT (~5 days), not the long-lived API key — re-paste from
        // dashboard.cohere.com network traffic (Authorization header) when
        // it expires. No auto-refresh path exists (not a browser cookie).
        auth: { kind: 'token', relogin: 're-paste dashboard session JWT (~5d lifespan)' },
        // Support/inference service usage ledger, informational only — no
        // quota cap is derivable from this endpoint.
        category: 'support',
        windows: [{ id: 'tokens', label: `Tokens (${WINDOW_DAYS}d)`, color: TOKENS_COLOR }],
        tiers: [],
      };
    },

    configure(cfg = {}) {
      // !== undefined so configure({api_token:''}) can explicitly clear it.
      if (cfg.api_token !== undefined) token = cfg.api_token ? String(cfg.api_token).trim() : null;
      if (cfg.org_id !== undefined) orgId = cfg.org_id ? String(cfg.org_id).trim() : null;
    },

    async setAuth(payload) {
      token = String(payload ?? '').trim() || null;
    },

    async fetch() {
      if (!token) throw new AuthExpiredError('no Cohere dashboard session token configured');
      if (!orgId) throw new Error('cohere: no org_id configured (see config.example.toml)');

      const now = new Date();
      const after = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

      const res = await fetch(USAGE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          'Request-Source': 'playground',
          Origin: 'https://dashboard.cohere.com',
          Referer: 'https://dashboard.cohere.com/',
        },
        body: JSON.stringify({
          req: { orgID: orgId, before: now.toISOString(), after: after.toISOString(), includeTotal: true },
        }),
      });

      if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
      if (res.status === 429) {
        throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
      }
      if (!res.ok) throw new Error(`production.api.os.cohere.com HTTP ${res.status}`);

      const body = await res.json();
      // Cache figures for meta() (parse() computes them too, but the runner
      // calls meta() independently of parse()).
      lastStats = parse(JSON.stringify(body))._cohere;
      return JSON.stringify(body);
    },

    intervalSeconds() {
      return 900; // billing ledger, no rush — poll less often than a live quota
    },

    meta() {
      return lastStats
        ? {
            input_tokens: lastStats.input_tokens,
            output_tokens: lastStats.output_tokens,
            total_tokens: lastStats.total_tokens,
          }
        : {};
    },

    parse,
  };
}

export { createProvider };
