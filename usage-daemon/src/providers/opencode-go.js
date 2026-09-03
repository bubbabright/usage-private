import os from 'node:os';
import path from 'node:path';

// OpenCode Go usage provider plugin — descriptor interface.
//
// Go subscription meters 3 rolling windows (5h / weekly / monthly), each
// server-computed as {status, resetInSec, usagePercent}. Source is the
// cookie-authed workspace "Go" page — a stable URL (no build-hash header, no
// seroval RPC body, unlike the console's `_server` endpoint). Same shape as
// ollama.js: cookie GET HTML -> scrape hydration -> windows.
//
// The scraped usagePercent lags reality — opencode.ai only batch-updates it
// periodically (confirmed live 2026-07-20: local CLI ran 117 requests / $0.10
// spend over 5h while the scraped page still read "0%"). The local opencode
// CLI's own SQLite db (~/.local/share/opencode/opencode.db) has per-message
// {cost, providerID, time.created} rows updated in real time, so when that
// file is readable we compute pct ourselves — sum(cost) over the trailing
// window ÷ the Go plan's published $ cap (5h=$12, weekly=$30, monthly=$60;
// confirmed via opencode.ai's usage-limits doc 2026-07-20) — and only fall
// back to the scraped percent when the db is missing/unreadable (e.g. daemon
// running on a host without the opencode CLI installed).
//
// parse() is still a PURE function (takes an envelope — either raw HTML for
// back-compat, or {html, localCosts, localSegments} JSON) so it unit-tests
// against a vendored fixture with no network/fs. fetch() adds cookie/db
// handling around it.

export const ROLLING_COLOR = '#009E73'; // Okabe-Ito green (5h)
export const WEEKLY_COLOR = '#56B4E9';  // Okabe-Ito blue
export const MONTHLY_COLOR = '#E69F00'; // Okabe-Ito orange

export const ID = 'opencode-go';
export const LABEL = 'OpenCode Go';

// Go plan's published $ limits (opencode.ai/docs usage-limits, confirmed live
// 2026-07-20). Rolling windows, not calendar-aligned.
export const CAPS = { '5h': 12, weekly: 30, monthly: 60 };
const WINDOW_MS = { '5h': 5 * 3600 * 1000, weekly: 7 * 24 * 3600 * 1000, monthly: 30 * 24 * 3600 * 1000 };

export class AuthExpiredError extends Error {
  constructor(msg = 'opencode.ai session expired') {
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

// Pull a `<key>:{...}` object literal out of the hydration script and read
// its fields by name (order in the source is not guaranteed). Real pages
// insert a Solid resumability reference between the key and the object
// literal — `rollingUsage:$R[33]={status:"ok",...}`, not `rollingUsage:{...}`
// — a hand-authored test fixture missed this and passed while the real page
// never matched (confirmed live 2026-07-18: raw capture had `$R[33]=` etc,
// parse() silently fell through to AuthExpiredError on a perfectly valid,
// 200-status page). The optional group tolerates that token generically
// (any `$R[<digits>]=`) without hardcoding a specific index.
function extractWindow(html, key) {
  const blockM = html.match(new RegExp(`${key}\\s*:\\s*(?:\\$R\\[\\d+\\]=)?\\{([^}]*)\\}`));
  if (!blockM) return null;
  const body = blockM[1];
  const statusM = body.match(/status\s*:\s*"([^"]+)"/);
  const resetM = body.match(/resetInSec\s*:\s*(\d+)/);
  const pctM = body.match(/usagePercent\s*:\s*(\d+(?:\.\d+)?)/);
  return {
    status: statusM ? statusM[1] : null,
    resetInSec: resetM ? Number(resetM[1]) : null,
    usagePercent: pctM ? Number(pctM[1]) : null,
  };
}

// raw is either the legacy bare HTML string (test fixtures, old callers) or a
// JSON envelope { html, localCosts, localSegments } — localCosts/localSegments
// are null when the local db was unavailable at fetch time.
function unwrapEnvelope(raw) {
  if (typeof raw === 'string') {
    try {
      const maybe = JSON.parse(raw);
      if (maybe && typeof maybe === 'object' && typeof maybe.html === 'string') {
        return { html: maybe.html, localCosts: maybe.localCosts ?? null, localSegments: maybe.localSegments ?? null };
      }
    } catch {
      // not JSON -> raw is HTML directly
    }
  }
  return { html: raw, localCosts: null, localSegments: null };
}

// Narrow but whitespace-tolerant scrape of the Go page hydration payload.
export function parse(raw) {
  const { html, localCosts, localSegments } = unwrapEnvelope(raw);
  if (!/rollingUsage/.test(html)) throw new AuthExpiredError();

  const rolling = extractWindow(html, 'rollingUsage');
  const weekly = extractWindow(html, 'weeklyUsage');
  const monthly = extractWindow(html, 'monthlyUsage');
  if (!rolling) throw new AuthExpiredError();

  const tierM = html.match(/"plan"\s*:\s*"([^"]+)"/) ?? html.match(/tier\s*:\s*"([^"]+)"/);
  const tier = tierM ? tierM[1].toLowerCase() : 'lite';

  const resetsAt = (w) =>
    w && Number.isFinite(w.resetInSec)
      ? new Date(Date.now() + w.resetInSec * 1000).toISOString()
      : null;

  // "ok" is the normal in-budget status; opencode.ai also reports
  // "rate-limited" (confirmed live 2026-08-17) once a window is exhausted —
  // that response still carries a valid usagePercent (100), it's not an
  // error state. Only "error" (see test fixture) means "no real data here."
  const scrapedPct = (w) =>
    w && (w.status === 'ok' || w.status === 'rate-limited') ? w.usagePercent : null;

  // Local db cost sum only informs the **5h rolling** window. That's the one
  // opencode.ai's scraped percentage lags on (batch-updated — confirmed live
  // 2026-07-20: 117 local requests / $0.10 over 5h while the page still read
  // 0%), so the real-time local $ ÷ cap can be the better signal there.
  //
  // Weekly/monthly are NOT overridden: opencode.ai's own percentages are the
  // authoritative billing figure, and the local trailing-window sums diverge
  // badly from it (observed 2026-07-23: local weekly and monthly costs came out
  // *identical* at $13.54 — everything in the last 7 days — giving weekly 45%
  // vs official 11% and monthly 23% vs official 41%). The local db simply does
  // not reconstruct opencode.ai's weekly/monthly accounting, so trust scraped.
  //
  // Local can also *under*-report — confirmed live 2026-08-17: this host's
  // local db had exactly one $0 message in the trailing 5h (real usage
  // happened through another device/session that never wrote to this db),
  // computing 0% while the scraped page correctly read ~100%. A local value
  // is only trustworthy when it's ahead of scraped, never when it's behind,
  // so take the max instead of letting local unconditionally win.
  const pctOf = (id, w) => {
    const cost = localCosts ? localCosts[id] : null;
    const scraped = scrapedPct(w);
    if (id === '5h' && typeof cost === 'number') {
      const localPct = Math.max(0, Math.min(100, (100 * cost) / CAPS[id]));
      return scraped == null ? localPct : Math.max(localPct, scraped);
    }
    return scraped;
  };

  const windows = [
    {
      id: '5h',
      label: '5 Hour',
      letter: '5h',
      pct: pctOf('5h', rolling),
      resets_at: resetsAt(rolling),
      color: ROLLING_COLOR,
      will_deplete: false,
    },
    {
      id: 'weekly',
      label: 'Weekly',
      letter: 'Wk',
      pct: pctOf('weekly', weekly),
      resets_at: resetsAt(weekly),
      color: WEEKLY_COLOR,
      will_deplete: false,
    },
    {
      id: 'monthly',
      label: 'Monthly',
      letter: 'Mo',
      pct: pctOf('monthly', monthly),
      resets_at: resetsAt(monthly),
      color: MONTHLY_COLOR,
      will_deplete: false,
    },
  ];

  const segments = Array.isArray(localSegments)
    ? localSegments.map((s) => ({ model: s.model, cost: s.cost }))
    : [];

  return { tier, windows, segments };
}

const BASE_URL = 'https://opencode.ai';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) usage-daemon/0.1';
const DEFAULT_DB_PATH = `${os.homedir()}/.local/share/opencode/opencode.db`;

// config.js's expandHome() resolves "~/" against process.cwd() (the daemon's
// convention for cookie files, kept relative to the project dir on purpose —
// see .gitignore's `.config/`/`local/` entries). The opencode CLI's real db
// lives under the actual OS home dir regardless of the daemon's cwd, so
// db_path needs real tilde expansion here instead.
function expandRealHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Reads the local opencode CLI's own SQLite db (WAL mode — safe to read
// concurrently with the CLI writing) for real-time per-window $ spend and a
// per-model breakdown. Soft-fails to null on any error (file missing/locked,
// node:sqlite unavailable, daemon running on a host without the CLI) so the
// scraped percent remains the fallback.
async function readLocalUsage(dbPath) {
  let db;
  try {
    // Dynamic import: node:sqlite is Node 22+ only; keep it optional so this
    // plugin still loads on older runtimes (falls back to scraped pct).
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
    const now = Date.now();
    const sumSince = (ms) => {
      const row = db
        .prepare(
          `SELECT SUM(json_extract(data,'$.cost')) as total FROM message
           WHERE json_extract(data,'$.providerID') = 'opencode-go'
           AND json_extract(data,'$.time.created') > ?`,
        )
        .get(now - ms);
      return row && typeof row.total === 'number' ? row.total : 0;
    };
    const costs = {
      '5h': sumSince(WINDOW_MS['5h']),
      weekly: sumSince(WINDOW_MS.weekly),
      monthly: sumSince(WINDOW_MS.monthly),
    };
    const segRows = db
      .prepare(
        `SELECT json_extract(data,'$.modelID') as model, SUM(json_extract(data,'$.cost')) as cost
         FROM message
         WHERE json_extract(data,'$.providerID') = 'opencode-go'
         AND json_extract(data,'$.time.created') > ?
         GROUP BY model
         ORDER BY cost DESC`,
      )
      .all(now - WINDOW_MS.monthly);
    const segments = segRows
      .filter((r) => r.model)
      .map((r) => ({ model: r.model, cost: r.cost }));
    return { costs, segments };
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

function createProvider() {
  let cookie = null;
  let workspaceId = null;
  let dbPath = null; // resolved lazily so configure() can override before first fetch

  async function discoverWorkspaceId() {
    const res = await fetch(`${BASE_URL}/workspace`, {
      headers: {
        Cookie: cookie,
        'User-Agent': USER_AGENT,
        Accept: 'text/html',
      },
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) throw new AuthExpiredError();
    if (res.status === 429) {
      throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
    }
    if (!res.ok) throw new Error(`opencode.ai HTTP ${res.status}`);
    const html = await res.text();
    const idM = html.match(/\bwrk_[A-Za-z0-9]+\b/);
    if (!idM) throw new AuthExpiredError('could not discover opencode workspace id');
    return idM[0];
  }

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'cookie' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://opencode.ai',
        auth: { kind: 'cookie' },
        windows: [
          { id: '5h', label: '5 Hour', color: ROLLING_COLOR },
          { id: 'weekly', label: 'Weekly', color: WEEKLY_COLOR },
          { id: 'monthly', label: 'Monthly', color: MONTHLY_COLOR },
        ],
        tiers: ['lite'],
      };
    },

    configure(cfg = {}) {
      // !== undefined (not truthy) so configure({cookie:''}) can explicitly
      // clear it — a flush action, not just "no change was requested".
      if (cfg.cookie !== undefined) cookie = cfg.cookie;
      // Accept either the bare id or a full workspace URL and pull the id
      // out of it — matches CodexBar's CODEXBAR_OPENCODE_WORKSPACE_ID
      // convention, one less thing for whoever configures this to get wrong
      // copy-pasting straight from the browser's address bar.
      if (cfg.workspace_id) {
        const m = String(cfg.workspace_id).match(/wrk_[A-Za-z0-9]+/);
        if (m) workspaceId = m[0];
      }
      if (cfg.db_path !== undefined) dbPath = expandRealHome(cfg.db_path);
    },

    async fetch() {
      if (!cookie) throw new AuthExpiredError('no opencode-go cookie configured');
      if (!workspaceId) workspaceId = await discoverWorkspaceId();

      const res = await fetch(`${BASE_URL}/workspace/${workspaceId}/go`, {
        headers: {
          Cookie: cookie,
          'User-Agent': USER_AGENT,
          Accept: 'text/html',
        },
        redirect: 'manual',
      });
      if (res.status >= 300 && res.status < 400) throw new AuthExpiredError();
      if (res.status === 429) {
        throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
      }
      if (!res.ok) throw new Error(`opencode.ai HTTP ${res.status}`);
      const html = await res.text();

      const local = await readLocalUsage(dbPath || DEFAULT_DB_PATH);
      return JSON.stringify({
        html,
        localCosts: local ? local.costs : null,
        localSegments: local ? local.segments : null,
      });
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
