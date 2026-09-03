// Claude Code usage provider plugin — descriptor interface (HANDOFF-14).
//
// Reads the OAuth usage endpoint with the same accessToken the `claude` CLI
// itself uses (~/.claude/.credentials.json). READ-ONLY: this daemon never
// writes that file and never refreshes the token — expired/missing token
// just reports auth_expired (see AuthExpiredError below); the CLI or `claude
// login` remain the only things that mutate it.
//
// parse() is a PURE function of the raw JSON text so it unit-tests against
// the vendored fixture (test/fixtures/claude-usage.json) with no network/fs.
// fetch() adds the credentials read + HTTP fetch + auth-expiry detection
// around it. Field mapping ported verbatim from
// claude-usage-extension/extension.js (the live extractor is the spec).

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const SESSION_COLOR = '#E69F00'; // Okabe-Ito orange (suite-wide)
export const WEEKLY_COLOR = '#56B4E9';  // Okabe-Ito blue
export const EXTRA_COLOR = '#009E73';   // Okabe-Ito green — extra/overage credits

export const ID = 'claude';
export const LABEL = 'Claude Code';

const API_URL = 'https://api.anthropic.com/api/oauth/usage';
// Anthropic buckets requests whose claude-code/<version> UA is too far behind
// the current CLI into aggressive 429s — see anthropics/claude-code#31021,
// #30930, #31637. Confirmed live 2026-07-31: UA claude-code/2.1.0 -> 429,
// claude-code/2.1.220 -> 200 against the same token. So the version MUST track
// the real CLI, not a frozen literal.
//
// Resolution order (see resolveUserAgentVersion): explicit config
// (`[providers.claude] user_agent_version`) > auto-detected `claude --version`
// (cached once at first poll) > this hardcoded fallback. Bump the fallback when
// you notice 429s creep back and can't rely on a local CLI to auto-detect.
const FALLBACK_CLAUDE_VERSION = '2.1.220';
const CLAUDE_UA_PREFIX = 'claude-code/';

// Extract a semver-ish "1.2.3" from `claude --version` output
// ("2.1.220 (Claude Code)") or a user-supplied version string.
function extractVersion(s) {
  const m = String(s ?? '').match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

// Detect the installed CLI version once; cache the promise so concurrent polls
// share a single `claude --version` spawn. Never throws — resolves null on any
// failure (not installed, PATH miss, timeout) so the caller falls back.
let detectPromise = null;
function detectCliVersion() {
  if (!detectPromise) {
    detectPromise = execFileP('claude', ['--version'], { timeout: 5000 })
      .then(({ stdout }) => extractVersion(stdout))
      .catch(() => null);
  }
  return detectPromise;
}

export class AuthExpiredError extends Error {
  constructor(msg = 'Claude Code token missing or expired') {
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

function defaultCredentialsPath() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, '.credentials.json');
}

// Pure function of the raw API JSON text — no fs/network. Throws
// AuthExpiredError if the payload doesn't look like a usage response
// (mirrors ollama's parse throwing on a logged-out page).
export function parse(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AuthExpiredError('unparseable usage response');
  }
  if (!data?.five_hour || !data?.seven_day) throw new AuthExpiredError();

  const windows = [
    {
      id: 'session',
      label: '5h',
      letter: '5h',
      pct: data.five_hour.utilization ?? null,
      resets_at: data.five_hour.resets_at ?? null,
      color: SESSION_COLOR,
      will_deplete: false,
    },
    {
      id: 'weekly',
      label: '7d',
      letter: 'Wk',
      pct: data.seven_day.utilization ?? null,
      resets_at: data.seven_day.resets_at ?? null,
      color: WEEKLY_COLOR,
      will_deplete: false,
    },
  ];

  // Extra usage ("usage credits") — pay-as-you-go spend that kicks in once a
  // plan limit is hit. Only surfaced when the feature is enabled on the
  // account (otherwise the block is present-but-off or null). Credits are
  // integer minor units scaled by decimal_places (e.g. 1361 @ dp=2 -> $13.61)
  // against monthly_limit (2000 @ dp=2 -> $20.00). Resets on the 1st of the
  // month (the API gives no reset date, so we derive next-month-start).
  const eu = data.extra_usage;
  if (eu && eu.is_enabled) {
    const dp = typeof eu.decimal_places === 'number' ? eu.decimal_places : 2;
    const div = 10 ** dp;
    const used = typeof eu.used_credits === 'number' ? eu.used_credits / div : null;
    const cap = typeof eu.monthly_limit === 'number' ? eu.monthly_limit / div : null;
    // Prefer the API's own utilization; fall back to used/cap when it's absent
    // or null (the endpoint stopped sending `utilization`, which left the bar
    // blank even though used+cap were present).
    const pct =
      typeof eu.utilization === 'number'
        ? eu.utilization
        : cap && cap > 0 && used != null
          ? (100 * used) / cap
          : null;
    windows.push({
      id: 'extra_usage',
      label: 'Usage Credits',
      letter: 'Cr',
      pct,
      used,
      cap,
      unit: eu.currency || 'USD',
      resets_at: nextMonthStart(),
      color: EXTRA_COLOR,
      will_deplete: false,
    });
  }

  return { tier: null, windows, segments: [] };
}

// First of next month, 00:00 UTC — the extra-usage monthly cap's reset
// boundary (the usage API omits a reset date; the account dashboard shows
// "Resets <1st of next month>").
export function nextMonthStart(from = new Date()) {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  return new Date(Date.UTC(y, m + 1, 1, 0, 0, 0)).toISOString().replace('.000', '');
}

function createProvider() {
  let credentialsPath = defaultCredentialsPath();
  let lastTokenExpiresAt = null; // surfaced via meta() — set on each successful credentials read
  let configuredVersion = null;  // explicit override from config, if any
  let resolvedUserAgent = null;  // cached final UA string once resolved

  // Resolve the claude-code/<version> UA once: config override > detected CLI
  // version > hardcoded fallback. Cached after the first successful resolve.
  async function resolveUserAgent() {
    if (resolvedUserAgent) return resolvedUserAgent;
    const version =
      configuredVersion || (await detectCliVersion()) || FALLBACK_CLAUDE_VERSION;
    resolvedUserAgent = CLAUDE_UA_PREFIX + version;
    return resolvedUserAgent;
  }

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'oauth-file' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://claude.ai/settings/usage',
        // path/relogin let a client explain an auth_expired instead of just
        // showing it: this token is read straight from the Claude CLI's own
        // credentials file and never refreshed here, so re-login IS the fix.
        auth: { kind: 'oauth-file', path: credentialsPath, relogin: 'claude  (then /login)' },
        windows: [
          { id: 'session', label: '5h', color: SESSION_COLOR },
          { id: 'weekly', label: '7d', color: WEEKLY_COLOR },
          { id: 'extra_usage', label: 'Usage Credits', color: EXTRA_COLOR },
        ],
        tiers: [],
      };
    },

    configure(cfg = {}) {
      const p = cfg.credentialsPath || cfg.credentials_path;
      if (p) credentialsPath = p;
      const v = extractVersion(cfg.user_agent_version || cfg.userAgentVersion);
      if (v) {
        configuredVersion = v;
        resolvedUserAgent = null; // force re-resolve with the new override
      }
    },

    async setAuth(payload) {
      await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
      await fs.writeFile(credentialsPath, payload + '\n', { mode: 0o600 });
    },

    async fetch() {
      let accessToken;
      try {
        const raw = await fs.readFile(credentialsPath, 'utf8');
        const json = JSON.parse(raw);
        accessToken = json?.claudeAiOauth?.accessToken;
        lastTokenExpiresAt = json?.claudeAiOauth?.expiresAt ?? null;
      } catch {
        throw new AuthExpiredError('no Claude Code credentials file found');
      }
      if (!accessToken) throw new AuthExpiredError('no accessToken in credentials file');

      const res = await fetch(API_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': await resolveUserAgent(),
        },
      });
      if (res.status === 401) throw new AuthExpiredError();
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || null;
        throw new RateLimitedError(retryAfter);
      }
      if (!res.ok) throw new Error(`api.anthropic.com HTTP ${res.status}`);
      return res.text();
    },

    intervalSeconds() {
      return 300;
    },

    // Optional generic hook (runner merges this into the snapshot if
    // present) — surfaces facts that live outside the parsed payload, here
    // the credentials file's own expiry, not part of the usage API response.
    meta() {
      return { token_expires_at: lastTokenExpiresAt };
    },

    parse,
  };
}

export { createProvider };
