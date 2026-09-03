// GitHub usage provider plugin — descriptor interface.
//
// GitHub's REST API rate-limit status, free and stable:
//   GET https://api.github.com/rate_limit
//     Authorization: Bearer <PAT>
//     -> { resources: { core: {limit,remaining,reset,used}, search: {...}, graphql: {...}, ... } }
// Confirmed live (hit unauthenticated during research, got the real current
// shape back). This measures REST/GraphQL/search API CALL BUDGET, not
// Copilot or Actions consumption — those live behind separate billing
// endpoints (GET /users/{username}/settings/billing/premium_request/usage
// etc, need `Plan: read` on a fine-grained PAT) that this plugin does NOT
// cover yet — two open questions there (does grossQuantity include
// under-allowance usage, is the enhanced billing platform rolled out to this
// account) need resolving against a real token before building that part.
//
// parse() is a PURE function of the raw JSON text.

export const CORE_COLOR = '#0072B2';   // Okabe-Ito blue
export const SEARCH_COLOR = '#E69F00'; // Okabe-Ito orange
export const GRAPHQL_COLOR = '#CC79A7'; // Okabe-Ito reddish-purple

export const ID = 'github';
export const LABEL = 'GitHub';

const API_URL = 'https://api.github.com';
const RATE_LIMIT_PATH = '/rate_limit';
const USER_AGENT = 'usage-daemon/0.1';
const API_VERSION = '2022-11-28';

export class AuthExpiredError extends Error {
  constructor(msg = 'GitHub API token missing or invalid') {
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

function windowFor(id, label, letter, color, resource) {
  if (!resource || typeof resource.limit !== 'number' || typeof resource.remaining !== 'number') return null;
  return {
    id,
    label,
    letter,
    pct: resource.limit > 0 ? Math.max(0, Math.min(100, (100 * (resource.limit - resource.remaining)) / resource.limit)) : null,
    used: resource.remaining, // remaining calls, not consumed
    used_is_remaining: true,
    cap: resource.limit,
    unit: 'calls',
    resets_at: typeof resource.reset === 'number' ? new Date(resource.reset * 1000).toISOString() : null,
    color,
    will_deplete: false,
  };
}

// Pure function of the raw JSON text — no fs/network.
export function parse(raw) {
  let env;
  try {
    env = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AuthExpiredError('unparseable GitHub rate_limit response');
  }
  if (!env || typeof env !== 'object' || !env.resources) {
    throw new AuthExpiredError('no usable GitHub rate_limit figures');
  }

  const windows = [
    windowFor('core', 'REST Calls', 'Rc', CORE_COLOR, env.resources.core),
    windowFor('search', 'Search Calls', 'Sr', SEARCH_COLOR, env.resources.search),
    windowFor('graphql', 'GraphQL Calls', 'Gq', GRAPHQL_COLOR, env.resources.graphql),
  ].filter(Boolean);

  if (windows.length === 0) {
    throw new AuthExpiredError('no usable GitHub rate_limit figures');
  }

  return {
    tier: null,
    windows,
    segments: [],
    // carried out of parse so meta() can surface the raw figures too.
    _github: {
      core_remaining: env.resources.core?.remaining ?? null,
      core_limit: env.resources.core?.limit ?? null,
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
        usageUrl: 'https://github.com/settings/tokens',
        auth: { kind: 'token' },
        category: 'support',
        windows: [{ id: 'core', label: 'REST Calls', color: CORE_COLOR }],
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
      if (!apiKey) throw new AuthExpiredError('no GitHub API token configured');

      const res = await fetch(`${API_URL}${RATE_LIMIT_PATH}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': USER_AGENT,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
        },
      });

      if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
      if (res.status === 429) {
        throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
      }
      if (!res.ok) throw new Error(`api.github.com HTTP ${res.status}`);

      const body = await res.json();
      lastStats = parse(JSON.stringify(body))._github;
      return JSON.stringify(body);
    },

    intervalSeconds() {
      return 300;
    },

    meta() {
      return lastStats
        ? {
            core_remaining: lastStats.core_remaining,
            core_limit: lastStats.core_limit,
          }
        : {};
    },

    parse,
  };
}

export { createProvider };
