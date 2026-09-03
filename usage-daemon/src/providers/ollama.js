// Ollama Cloud usage provider plugin — descriptor interface (HANDOFF-14).
//
// No JSON usage API — account usage is server-rendered HTML at
// https://ollama.com/settings ("Usage" tab, htmx). Auth is the browser session
// cookie, NOT the API key.
//
// parse() is a PURE function of the page HTML so it unit-tests against the
// vendored fixture (test/fixtures/ollama-settings.html) with no network.
// fetch() adds the fetch + auth-expiry detection around it.

export const SESSION_COLOR = '#E69F00'; // Okabe-Ito orange (suite-wide)
export const WEEKLY_COLOR = '#56B4E9';  // Okabe-Ito blue

export const ID = 'ollama';
export const LABEL = 'Ollama Cloud';

export class AuthExpiredError extends Error {
  constructor(msg = 'ollama.com session expired') {
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

// Narrow but whitespace-tolerant scrapes; fail soft (null) per field.
export function parse(html) {
  // Logged-out pages have no "Cloud usage" block (redirect body or /signin).
  if (!/Cloud usage/.test(html)) throw new AuthExpiredError();

  // tier: the capitalize-classed pill right after the "Cloud usage" heading.
  // Markup splits `capitalize"` from `>free</span` across newlines — tolerate it.
  const tierM = html.match(/capitalize"[^>]*>\s*([A-Za-z]+)\s*<\/span/);
  const tier = tierM ? tierM[1].toLowerCase() : 'unknown';

  // pct may be a decimal on real pages (e.g. "0.4% used"), not just an integer.
  const sessM = html.match(/aria-label="Session usage (\d+(?:\.\d+)?)% used"/);
  const weekM = html.match(/aria-label="Weekly usage (\d+(?:\.\d+)?)% used"/);

  // reset timestamps: 1st data-time = session, 2nd = weekly.
  const times = [...html.matchAll(/data-time="([^"]+)"/g)].map((m) => m[1]);

  const windows = [
    {
      id: 'session',
      label: 'Session',
      letter: 'Se', // ollama's "session" has no fixed duration (unlike claude's 5h) — no clean abbreviation yet
      pct: sessM ? Number(sessM[1]) : null,
      resets_at: times[0] ?? null,
      color: SESSION_COLOR,
      will_deplete: false,
    },
    {
      id: 'weekly',
      label: 'Weekly',
      letter: 'Wk',
      pct: weekM ? Number(weekM[1]) : null,
      resets_at: times[1] ?? null,
      color: WEEKLY_COLOR,
      will_deplete: false,
    },
  ];

  // per-model segments only render at usage > 0 (absent in the 0% fixture).
  const segments = [
    ...html.matchAll(
      /data-usage-segment\b[^>]*?data-model="([^"]+)"[^>]*?data-requests="(\d+)"/g,
    ),
  ].map((m) => ({ model: m[1], requests: Number(m[2]) }));

  return { tier, windows, segments };
}

const DEFAULT_URL = 'https://ollama.com/settings';

// Internal state for the plugin instance
function createProvider() {
  let cookie = null;
  let url = DEFAULT_URL;

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'cookie' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://ollama.com/settings',
        auth: { kind: 'cookie' },
        windows: [
          { id: 'session', label: 'Session', color: SESSION_COLOR },
          { id: 'weekly', label: 'Weekly', color: WEEKLY_COLOR },
        ],
        tiers: ['free', 'pro'],
      };
    },

    configure(cfg = {}) {
      // !== undefined (not truthy) so configure({cookie:''}) can explicitly
      // clear it — a flush action, not just "no change was requested".
      if (cfg.cookie !== undefined) cookie = cfg.cookie;
      if (cfg.url) url = cfg.url;
    },

    async fetch() {
      if (!cookie) throw new AuthExpiredError('no ollama cookie configured');
      const res = await fetch(url, {
        headers: {
          Cookie: cookie,
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) usage-daemon/0.1',
          Accept: 'text/html',
        },
        redirect: 'manual',
      });
      // 3xx to /signin (or any redirect) = logged out.
      if (res.status >= 300 && res.status < 400) throw new AuthExpiredError();
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || null;
        throw new RateLimitedError(retryAfter);
      }
      if (!res.ok) throw new Error(`ollama.com HTTP ${res.status}`);
      return res.text();
    },

    parse,
  };
}

export { createProvider };