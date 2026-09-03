// Consensus usage provider plugin — descriptor interface.
//
// Consensus (consensus.app — AI research/academic search) uses Clerk for
// auth. There is no Consensus-specific usage endpoint: the monthly counters
// shown on consensus.app/settings/subscription/ live in the Clerk session's
// own user object, at public_metadata.used_pro_search_queries /
// used_deep_search_queries / used_consensus_snapshot_queries (arrays; the
// USED count is the array length) and public_metadata.last_reset_date.
//
//   GET https://clerk.consensus.app/v1/client?__clerk_api_version=<v>&_clerk_js_version=<v>
//     -> { response: { sessions: [{ status, user: { public_metadata } }] } }
//
// The per-cycle CAPS (15 pro messages / 3 deep reviews / 10 snapshots) are
// NOT present anywhere in this payload — they're free-tier plan constants
// read off the /settings/subscription/ UI, not the API. If the account is
// upgraded off the free tier these caps go stale (window would under-report
// pct). No plan/tier field was found in public_metadata to branch on.
//
// Auth: browser session cookie for consensus.app (cookie kind, same as
// tavily/context7). The registrable domain "consensus.app" also covers the
// clerk.consensus.app subdomain's cookies (same pattern context7 relies on
// for clerk.context7.com), so cookie_from_firefox = "consensus.app" pulls
// everything this fetch() needs.
//
// parse() is a PURE function of the envelope JSON text.

export const PRO_COLOR = '#E69F00';   // Okabe-Ito orange
export const DEEP_COLOR = '#56B4E9';  // Okabe-Ito blue
export const SNAPSHOT_COLOR = '#009E73'; // Okabe-Ito green

export const ID = 'consensus';
export const LABEL = 'Consensus';

const CLERK_URL = 'https://clerk.consensus.app';
const CLERK_API_VERSION = '2026-05-12';
const CLERK_JS_VERSION = '6.29.2';
const USER_AGENT = 'usage-daemon/0.1';

// Free-tier monthly caps — read off the settings/subscription page UI, not
// returned anywhere in the Clerk payload. See module comment above.
const FREE_PRO_CAP = 15;
const FREE_DEEP_CAP = 3;
const FREE_SNAPSHOT_CAP = 10;

// Consensus's cycle resets exactly 30 days after last_reset_date (observed:
// last_reset_date 2026-08-22 -> UI shows "resets on September 21st").
const RESET_CYCLE_DAYS = 30;

export class AuthExpiredError extends Error {
  constructor(msg = 'Consensus session cookie missing or expired') {
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

function addDaysIso(iso, days) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

// Pure function of the Clerk /v1/client envelope JSON text — no fs/network.
export function parse(raw) {
  let env;
  try {
    env = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AuthExpiredError('unparseable consensus/clerk envelope');
  }
  if (!env || typeof env !== 'object') {
    throw new AuthExpiredError('unparseable consensus/clerk envelope');
  }

  const sessions = env.response?.sessions ?? env.client?.sessions ?? [];
  const session = sessions.find((s) => s.status === 'active') ?? sessions[0];
  const meta = session?.user?.public_metadata;
  if (!meta) {
    throw new AuthExpiredError('no active Consensus session in Clerk envelope');
  }

  const proUsed = Array.isArray(meta.used_pro_search_queries) ? meta.used_pro_search_queries.length : null;
  const deepUsed = Array.isArray(meta.used_deep_search_queries) ? meta.used_deep_search_queries.length : null;
  const snapshotUsed = Array.isArray(meta.used_consensus_snapshot_queries)
    ? meta.used_consensus_snapshot_queries.length
    : null;

  if (proUsed == null && deepUsed == null && snapshotUsed == null) {
    throw new AuthExpiredError('no usable Consensus query counters in public_metadata');
  }

  const resetsAt = typeof meta.last_reset_date === 'string' ? addDaysIso(meta.last_reset_date, RESET_CYCLE_DAYS) : null;

  const windows = [];
  if (proUsed != null) {
    windows.push({
      id: 'pro_messages',
      label: 'Pro Messages',
      letter: 'Pr',
      pct: clampPct((100 * proUsed) / FREE_PRO_CAP),
      used: proUsed,
      cap: FREE_PRO_CAP,
      unit: 'messages',
      resets_at: resetsAt,
      color: PRO_COLOR,
      will_deplete: false,
    });
  }
  if (deepUsed != null) {
    windows.push({
      id: 'deep_reviews',
      label: 'Deep Reviews',
      letter: 'Dp',
      pct: clampPct((100 * deepUsed) / FREE_DEEP_CAP),
      used: deepUsed,
      cap: FREE_DEEP_CAP,
      unit: 'reviews',
      resets_at: resetsAt,
      color: DEEP_COLOR,
      will_deplete: false,
    });
  }
  if (snapshotUsed != null) {
    windows.push({
      id: 'snapshots',
      label: 'Snapshots',
      letter: 'Sn',
      pct: clampPct((100 * snapshotUsed) / FREE_SNAPSHOT_CAP),
      used: snapshotUsed,
      cap: FREE_SNAPSHOT_CAP,
      unit: 'snapshots',
      resets_at: resetsAt,
      color: SNAPSHOT_COLOR,
      will_deplete: false,
    });
  }

  return {
    tier: null, // not present anywhere in the Clerk payload
    windows,
    segments: [],
    // carried out of parse so meta() can surface the raw figures too.
    _consensus: {
      pro_used: proUsed,
      deep_used: deepUsed,
      snapshot_used: snapshotUsed,
      last_reset_date: meta.last_reset_date ?? null,
    },
  };
}

function createProvider() {
  let cookie = null;
  let lastStats = null; // surfaced via meta()

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'cookie' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://consensus.app/settings/subscription/',
        auth: { kind: 'cookie' },
        // Support service (research search), not an AI plan: a metered API
        // that backs the work rather than being the work.
        category: 'support',
        windows: [
          { id: 'pro_messages', label: 'Pro Messages', color: PRO_COLOR },
          { id: 'deep_reviews', label: 'Deep Reviews', color: DEEP_COLOR },
          { id: 'snapshots', label: 'Snapshots', color: SNAPSHOT_COLOR },
        ],
        tiers: [],
      };
    },

    configure(cfg = {}) {
      // !== undefined so configure({cookie:''}) can explicitly clear it.
      if (cfg.cookie !== undefined) cookie = cfg.cookie ? String(cfg.cookie).trim() : null;
    },

    async fetch() {
      if (!cookie) throw new AuthExpiredError('no Consensus session cookie configured');

      const url = `${CLERK_URL}/v1/client?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`;
      const res = await fetch(url, {
        headers: {
          Cookie: cookie,
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          Referer: 'https://consensus.app/',
          Origin: 'https://consensus.app',
        },
      });

      if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
      if (res.status === 429) {
        throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
      }
      if (!res.ok) throw new Error(`clerk.consensus.app HTTP ${res.status}`);

      const body = await res.json();
      // Cache figures for meta() (parse() computes them too, but the runner
      // calls meta() independently of parse()).
      lastStats = parse(JSON.stringify(body))._consensus;
      return JSON.stringify(body);
    },

    intervalSeconds() {
      return 300;
    },

    meta() {
      return lastStats
        ? {
            pro_used: lastStats.pro_used,
            deep_used: lastStats.deep_used,
            snapshot_used: lastStats.snapshot_used,
            last_reset_date: lastStats.last_reset_date,
          }
        : {};
    },

    parse,
  };
}

export { createProvider };
