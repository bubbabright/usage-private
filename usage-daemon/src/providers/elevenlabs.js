// ElevenLabs usage provider plugin — descriptor interface.
//
// ElevenLabs subscription usage from GET api.elevenlabs.io/v1/user/subscription
// (free call, xi-api-key header). Confirmed shape and field names against the
// CodexBar reference (/mnt/nas/projects/codexbar-main/docs/elevenlabs.md,
// Tests/CodexBarTests/ElevenLabsUsageFetcherTests.swift), not just docs prose.
//
// parse() is a PURE function of the raw JSON text.

export const CHARACTERS_COLOR = '#0072B2'; // Okabe-Ito blue
export const VOICE_SLOTS_COLOR = '#CC79A7'; // Okabe-Ito reddish-purple

export const ID = 'elevenlabs';
export const LABEL = 'ElevenLabs';

const DEFAULT_API_URL = 'https://api.elevenlabs.io';
const SUBSCRIPTION_PATH = '/v1/user/subscription';
const USER_AGENT = 'usage-daemon/0.1';

export class AuthExpiredError extends Error {
  constructor(msg = 'ElevenLabs API key missing or invalid') {
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

// Pure function of the raw JSON text — no fs/network.
export function parse(raw) {
  let env;
  try {
    env = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AuthExpiredError('unparseable ElevenLabs subscription response');
  }
  if (!env || typeof env !== 'object' || typeof env.character_count !== 'number') {
    throw new AuthExpiredError('no usable ElevenLabs subscription figures');
  }

  const consumed = env.character_count;
  const cap = typeof env.character_limit === 'number' ? env.character_limit : null;
  const resetsAt =
    typeof env.next_character_count_reset_unix === 'number'
      ? new Date(env.next_character_count_reset_unix * 1000).toISOString()
      : null;

  const windows = [
    {
      id: 'characters',
      label: 'Characters',
      letter: 'Ch',
      pct: cap && cap > 0 ? clampPct((100 * consumed) / cap) : null,
      used: cap != null ? Math.max(0, cap - consumed) : null, // remaining, not consumed
      used_is_remaining: true,
      cap,
      unit: 'characters',
      resets_at: resetsAt,
      color: CHARACTERS_COLOR,
      will_deplete: false,
    },
  ];

  if (typeof env.voice_slots_used === 'number' && typeof env.voice_limit === 'number') {
    windows.push({
      id: 'voice_slots',
      label: 'Voice Slots',
      letter: 'Vs',
      pct: env.voice_limit > 0 ? clampPct((100 * env.voice_slots_used) / env.voice_limit) : null,
      used: env.voice_slots_used,
      cap: env.voice_limit,
      unit: 'voices',
      resets_at: null,
      color: VOICE_SLOTS_COLOR,
      will_deplete: false,
    });
  }

  return {
    tier: env.tier ?? null,
    windows,
    segments: [],
    // carried out of parse so meta() can surface the raw figures too.
    _elevenlabs: {
      character_count: consumed,
      character_limit: cap,
      // NOT "status" -- that key collides with the daemon's own top-level
      // snapshot status (ok/auth_expired/...) when meta() gets spread in
      // (runner.js: `status: STATUS.OK, ...meta`), silently clobbering it.
      account_status: env.status ?? null,
      tier: env.tier ?? null,
    },
  };
}

function createProvider() {
  let apiKey = null;
  let apiUrl = DEFAULT_API_URL;
  let lastStats = null; // surfaced via meta()

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'token' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://elevenlabs.io/app/settings/api-keys',
        auth: { kind: 'token' },
        category: 'support',
        windows: [{ id: 'characters', label: 'Characters', color: CHARACTERS_COLOR }],
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
      if (!apiKey) throw new AuthExpiredError('no ElevenLabs API key configured');

      const res = await fetch(`${apiUrl}${SUBSCRIPTION_PATH}`, {
        headers: {
          'xi-api-key': apiKey,
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
      });

      if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
      if (res.status === 429) {
        throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
      }
      if (!res.ok) throw new Error(`api.elevenlabs.io HTTP ${res.status}`);

      const body = await res.json();
      lastStats = parse(JSON.stringify(body))._elevenlabs;
      return JSON.stringify(body);
    },

    intervalSeconds() {
      return 300;
    },

    meta() {
      return lastStats
        ? {
            character_count: lastStats.character_count,
            character_limit: lastStats.character_limit,
            account_status: lastStats.account_status,
          }
        : {};
    },

    parse,
  };
}

export { createProvider };
