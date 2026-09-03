// OpenRouter usage provider plugin — descriptor interface.
//
// Credit/balance model (not a rolling time-window like claude 5h). One API key
// (Bearer) drives two REST reads, assembled into a JSON envelope { key, credits }:
//   - GET https://openrouter.ai/api/v1/key      -> per-key limit + spend buckets
//   - GET https://openrouter.ai/api/v1/credits  -> account credits (total/used)
// The same inference key authorizes /key; /credits needs a provisioning key and
// 401s on a normal key — soft, we just drop the credits window then.
//
// Two meters (emit whichever is available; need >=1):
//   - key_limit : usage / limit * 100 when the key has a credit cap (limit!=null).
//                 A credit cap, not a calendar window -> resets_at null.
//   - credits   : total_usage / total_credits * 100 (account prepaid balance).
//                 Top-up balance -> resets_at null; will_deplete still meaningful.
//
// parse() is a PURE function of the envelope JSON text so it unit-tests against
// a vendored fixture with no network. Field names confirmed against CodexBar's
// OpenRouterUsageStats.swift + openrouter.ai/docs/api/reference/limits.

export const LIMIT_COLOR = '#56B4E9';  // Okabe-Ito blue
export const CREDITS_COLOR = '#E69F00'; // Okabe-Ito orange

export const ID = 'openrouter';
export const LABEL = 'OpenRouter';

const KEY_URL = 'https://openrouter.ai/api/v1/key';
const CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) usage-daemon/0.1';

export class AuthExpiredError extends Error {
  constructor(msg = 'OpenRouter API key missing or invalid') {
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
export function parse(raw) {
  let envelope;
  try {
    envelope = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AuthExpiredError('unparseable openrouter envelope');
  }
  if (!envelope || typeof envelope !== 'object') {
    throw new AuthExpiredError('unparseable openrouter envelope');
  }

  const windows = [];
  let tier = null;

  // --- /key: per-key limit + spend ---
  let keyData = null;
  if (envelope.key) {
    let parsed;
    try {
      parsed = typeof envelope.key === 'string' ? JSON.parse(envelope.key) : envelope.key;
    } catch {
      parsed = null;
    }
    keyData = parsed?.data ?? null;
  }
  if (keyData && typeof keyData === 'object') {
    if (keyData.is_free_tier === true) tier = 'free';
    else if (keyData.is_free_tier === false) tier = 'paid';

    const limit = keyData.limit;
    const usage = keyData.usage;
    if (typeof limit === 'number' && limit > 0 && typeof usage === 'number') {
      windows.push({
        id: 'key_limit',
        label: 'Key',
        letter: 'Ky',
        pct: clampPct((100 * usage) / limit),
        resets_at: null, // credit cap on the key, not a calendar reset
        color: LIMIT_COLOR,
        will_deplete: false,
      });
    }
  }

  // --- /credits: account prepaid balance ---
  let creditsData = null;
  if (envelope.credits) {
    let parsed;
    try {
      parsed =
        typeof envelope.credits === 'string' ? JSON.parse(envelope.credits) : envelope.credits;
    } catch {
      parsed = null;
    }
    creditsData = parsed?.data ?? null;
  }
  if (creditsData && typeof creditsData === 'object') {
    const total = creditsData.total_credits;
    const used = creditsData.total_usage;
    if (typeof total === 'number' && total > 0 && typeof used === 'number') {
      windows.push({
        id: 'credits',
        label: 'Balance',
        letter: 'Bal',
        pct: clampPct((100 * used) / total),
        used,
        cap: total,
        unit: 'USD',
        resets_at: null, // prepaid top-up balance, no reset
        color: CREDITS_COLOR,
        will_deplete: false,
      });
    } else if (typeof used === 'number') {
      // No pre-purchased credit pool to be a fraction of — the common case for
      // a key that has never bought credits, and for uncapped keys. There is
      // still a real number to report: the balance, exactly what CodexBar
      // surfaces as "Balance: $X.XX". Emitting it with pct null (rather than
      // dropping it) is the difference between a working key rendering as a
      // value and the whole provider erroring out with "no usable meter".
      windows.push({
        id: 'credits',
        label: 'Balance',
        letter: 'Bal',
        pct: null, // no cap -> no bar; clients render this as a value tile
        used: Math.round(((typeof total === 'number' ? total : 0) - used) * 100) / 100,
        cap: null,
        unit: 'USD',
        used_is_remaining: true,
        resets_at: null,
        color: CREDITS_COLOR,
        will_deplete: false,
      });
    }
  }

  if (windows.length === 0) {
    // NOT an auth failure: the key authenticated fine, it simply exposes no
    // meter we can read. Reporting this as auth_expired sent an entirely
    // healthy key down the "your credentials are bad" path.
    throw new Error('OpenRouter returned no usable meter (no key limit, no credits data)');
  }

  return { tier, windows, segments: [] };
}

function createProvider() {
  let apiKey = null;

  async function get(url) {
    return fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
  }

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'token' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://openrouter.ai/activity',
        auth: { kind: 'token' },
        windows: [
          { id: 'key_limit', label: 'Key', color: LIMIT_COLOR },
          { id: 'credits', label: 'Balance', color: CREDITS_COLOR },
        ],
        tiers: ['free', 'paid'],
      };
    },

    configure(cfg = {}) {
      // !== undefined so configure({api_key:''}) can explicitly clear it.
      if (cfg.api_key !== undefined) apiKey = cfg.api_key ? String(cfg.api_key).trim() : null;
      if (cfg.apiKey !== undefined) apiKey = cfg.apiKey ? String(cfg.apiKey).trim() : null;
    },

    async setAuth(payload) {
      apiKey = String(payload ?? '').trim() || null;
    },

    async fetch() {
      if (!apiKey) throw new AuthExpiredError('no OpenRouter API key configured');

      let key = null;
      let credits = null;
      let rateLimited = null;

      // NEITHER endpoint is hard-required, and neither one's 401 proves the
      // key is bad. An earlier cut treated /key as primary and threw
      // auth_expired the moment it returned 401/403 — so a key that /credits
      // would have happily answered was reported as invalid, and /credits was
      // never even tried. CodexBar's docs have it the other way round:
      // /credits is the primary balance read and /key is "optional enrichment"
      // it degrades past. Try both, and only call it an auth failure when both
      // refuse the key.
      let keyDenied = false;
      let credDenied = false;

      try {
        const keyRes = await get(KEY_URL);
        if (keyRes.status === 401 || keyRes.status === 403) {
          keyDenied = true;
        } else if (keyRes.status === 429) {
          rateLimited = Number(keyRes.headers.get('retry-after')) || null;
        } else if (keyRes.ok) {
          key = await keyRes.text();
        }
      } catch {
        // network — /credits may still answer
      }

      try {
        const credRes = await get(CREDITS_URL);
        if (credRes.status === 401 || credRes.status === 403) {
          credDenied = true;
        } else if (credRes.status === 429) {
          rateLimited = rateLimited ?? (Number(credRes.headers.get('retry-after')) || null);
        } else if (credRes.ok) {
          credits = await credRes.text();
        }
      } catch {
        // network — key may still carry a usable meter
      }

      if (!key && !credits) {
        if (rateLimited != null) throw new RateLimitedError(rateLimited);
        // Both endpoints rejected the key: that is a real auth failure.
        if (keyDenied && credDenied) {
          throw new AuthExpiredError('OpenRouter rejected this key on both /key and /credits');
        }
        throw new Error('openrouter.ai returned no usable body');
      }
      return JSON.stringify({ key, credits });
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
