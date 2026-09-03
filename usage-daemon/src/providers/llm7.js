// LLM7 token quota usage provider plugin — descriptor interface.
//
// Token-level daily quota from api-token.llm7.io (the dashboard session JWT,
// not an API key). Rolling 24h window, 1M token daily limit on the free tier.
// Auth is a Bearer JWT — the same token the dashboard SPA uses.
//
// Single meter: daily_tokens — used/limit with remaining count.
// refresh window is 86400 seconds (24h) from the first request in the window.
//
// parse() is a PURE function of the raw JSON text. fetch() adds the Bearer
// auth + fetch around it.

export const TOKEN_COLOR = '#56B4E9'; // Okabe-Ito blue

export const ID = 'llm7';
export const LABEL = 'LLM7';

const API_URL = 'https://api-token.llm7.io/my/token-quota';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) usage-daemon/0.1';

export class AuthExpiredError extends Error {
  constructor(msg = 'LLM7 token missing or invalid') {
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
    throw new AuthExpiredError('unparseable llm7 response');
  }
  if (!data || typeof data !== 'object') {
    throw new AuthExpiredError('unparseable llm7 response');
  }

  // Auth failures surface as { error, message }.
  if (data.error) {
    throw new AuthExpiredError(`llm7: ${data.message || data.error}`);
  }

  const used = data.used_tokens;
  const limit = data.limit_tokens;
  const remaining = data.remaining_tokens;

  if (typeof used !== 'number' || typeof limit !== 'number' || limit <= 0) {
    throw new AuthExpiredError('no usable LLM7 token quota figures');
  }

  const pct = Math.max(0, Math.min(100, (100 * used) / limit));

  // 86400s = 24h rolling window from the first request, no fixed reset boundary.
  const resetsAt = null;

  const windows = [
    {
      id: 'daily_tokens',
      label: 'Tokens',
      letter: 'Tk',
      pct,
      used,              // consumed tokens (2,431)
      cap: limit,        // daily cap (1,000,000)
      unit: 'tokens',
      resets_at: resetsAt,
      color: TOKEN_COLOR,
      will_deplete: false,
    },
  ];

  return {
    tier: data.tier ?? null,
    windows,
    segments: [],
    // Surface the raw remaining figure for meta() — lets the UI show
    // "997,569 remaining" alongside the bar.
    _llm7: { remaining: typeof remaining === 'number' && Number.isFinite(remaining) ? remaining : null },
  };
}

function createProvider() {
  let apiToken = null;
  let lastRemaining = null; // surfaced via meta()

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'token' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://dash.llm7.io/#/usage',
        // Not the LLM7 inference API key — the dashboard SESSION JWT (DevTools ->
        // Network -> any api-token.llm7.io request -> Authorization header).
        // Pasting the API key instead is the classic mistake here (see AGENTS.md).
        auth: { kind: 'token', relogin: 'dashboard session JWT from dash.llm7.io (DevTools Network tab), not the API key' },
        windows: [{ id: 'daily_tokens', label: 'Tokens', color: TOKEN_COLOR }],
        tiers: [],
      };
    },

    configure(cfg = {}) {
      // !== undefined so configure({api_token:''}) can explicitly clear it.
      if (cfg.api_token !== undefined) apiToken = cfg.api_token ? String(cfg.api_token).trim() : null;
      if (cfg.token !== undefined) apiToken = cfg.token ? String(cfg.token).trim() : apiToken;
    },

    async setAuth(payload) {
      apiToken = String(payload ?? '').trim() || null;
    },

    async fetch() {
      if (!apiToken) throw new AuthExpiredError('no LLM7 token configured');

      const res = await fetch(API_URL, {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'User-Agent': USER_AGENT,
          Accept: 'application/json, text/plain, */*',
          Origin: 'https://dash.llm7.io',
        },
      });

      if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
      if (res.status === 429) {
        throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
      }
      if (!res.ok) throw new Error(`api-token.llm7.io HTTP ${res.status}`);

      const text = await res.text();
      // Cache remaining figure for meta()
      const parsed = parse(text);
      lastRemaining = parsed._llm7?.remaining ?? null;
      return text;
    },

    intervalSeconds() {
      return 300;
    },

    meta() {
      return lastRemaining != null ? { tokens_remaining: lastRemaining } : {};
    },

    parse,
  };
}

export { createProvider };