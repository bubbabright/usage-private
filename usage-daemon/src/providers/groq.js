// Groq usage provider plugin — descriptor interface.
//
// Groq has NO public spend/usage API (see extensions/groq-usage/RESEARCH.md —
// dev/free tier: only the documented `x-ratelimit-*` response headers on
// api.groq.com/openai/v1/* calls; $ spend is console-only, undocumented,
// unconfirmed). So this plugin polls RPD (daily request) headroom from those
// headers instead of a dedicated usage endpoint. Groq's `x-ratelimit-*-tokens`
// headers are always TPM (resets every ~60s) with no daily/token-quota
// equivalent exposed on this tier — too noisy to be useful on a daily-glance
// panel, so this plugin doesn't read or surface them.
//
// There is no free "status only" call — reading the headers costs a real
// inference request (ticks RPD), so fetch() sends the cheapest possible
// completion (max_tokens: 1, tiny prompt) purely to read its headers.
//
// Auth: `Authorization: Bearer <API_KEY>`. parse() is a PURE function of the
// envelope JSON text; fetch() converts Groq's duration-string resets
// (e.g. "2m59.56s", "1.2s", "120ms", "3h2m59s") into an absolute resets_at
// before building the envelope, since parse() must stay independent of
// wall-clock.

export const RPD_COLOR = '#CC79A7'; // Okabe-Ito reddish-purple

export const ID = 'groq';
export const LABEL = 'Groq';

const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const USER_AGENT = 'usage-daemon/0.1';
// llama-3.1-8b-instant is listed in Groq's public rate-limit docs but is not
// actually served to every account/key (verified 404 model_not_found live
// against a real key with GET /openai/v1/models confirming it's absent from
// that key's accessible set) -- gpt-oss-20b showed up on that same list and
// is a small, current model, so it's a safer default probe.
const DEFAULT_MODEL = 'openai/gpt-oss-20b';

export class AuthExpiredError extends Error {
  constructor(msg = 'Groq API key missing or invalid') {
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

// "2m59.56s" / "1.2s" / "120ms" / "45s" -> seconds (float). Returns null if
// unparseable so callers can fall back to no-reset rather than throwing.
export function parseDuration(str) {
  if (typeof str !== 'number') {
    if (typeof str !== 'string' || !str) return null;
    const m = str.match(/^(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)(ms|s)$/);
    if (!m) return null;
    const hours = m[1] ? Number(m[1]) : 0;
    const minutes = m[2] ? Number(m[2]) : 0;
    const value = Number(m[3]);
    const unit = m[4];
    const seconds = unit === 'ms' ? value / 1000 : value;
    return hours * 3600 + minutes * 60 + seconds;
  }
  return str;
}

// Pure function of the envelope JSON text — no fs/network.
// envelope: { limit_requests, remaining_requests, reset_requests_at }
// reset_requests_at is an absolute ISO timestamp computed by fetch() at
// request time.
export function parse(raw) {
  let env;
  try {
    env = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AuthExpiredError('unparseable groq envelope');
  }
  if (!env || typeof env !== 'object') {
    throw new AuthExpiredError('unparseable groq envelope');
  }

  const windows = [];

  const limitReq = env.limit_requests;
  const remReq = env.remaining_requests;
  if (typeof limitReq === 'number' && limitReq > 0 && typeof remReq === 'number') {
    windows.push({
      id: 'daily_requests',
      label: 'Requests/day',
      letter: 'Rq',
      pct: clampPct(100 * (1 - remReq / limitReq)),
      resets_at: env.reset_requests_at ?? null,
      color: RPD_COLOR,
      will_deplete: false,
    });
  }

  if (windows.length === 0) {
    throw new AuthExpiredError('no usable Groq rate-limit headers in envelope');
  }

  return { tier: null, windows, segments: [] };
}

function createProvider() {
  let apiKey = null;
  let model = DEFAULT_MODEL;

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'token' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://console.groq.com/usage',
        auth: { kind: 'token' },
        windows: [
          { id: 'daily_requests', label: 'Requests/day', color: RPD_COLOR },
        ],
        tiers: [],
      };
    },

    configure(cfg = {}) {
      // !== undefined so configure({api_key:''}) can explicitly clear it.
      if (cfg.api_key !== undefined) apiKey = cfg.api_key ? String(cfg.api_key).trim() : null;
      if (cfg.model) model = String(cfg.model).trim();
    },

    async setAuth(payload) {
      apiKey = String(payload ?? '').trim() || null;
    },

    async fetch() {
      if (!apiKey) throw new AuthExpiredError('no Groq API key configured');

      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
      });

      if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
      if (res.status === 429) {
        throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
      }
      if (!res.ok) throw new Error(`api.groq.com HTTP ${res.status}`);
      await res.text(); // drain body, we only need headers

      const now = Date.now();
      const limitRequests = Number(res.headers.get('x-ratelimit-limit-requests'));
      const remainingRequests = Number(res.headers.get('x-ratelimit-remaining-requests'));
      const resetRequestsSec = parseDuration(res.headers.get('x-ratelimit-reset-requests'));

      const envelope = {
        limit_requests: Number.isFinite(limitRequests) ? limitRequests : null,
        remaining_requests: Number.isFinite(remainingRequests) ? remainingRequests : null,
        reset_requests_at: resetRequestsSec != null ? new Date(now + resetRequestsSec * 1000).toISOString() : null,
      };
      return JSON.stringify(envelope);
    },

    intervalSeconds() {
      // Longer than the 300s default — each poll burns a real token/RPD tick.
      return 900;
    },

    meta() {
      return {};
    },

    parse,
  };
}

export { createProvider };
