// Read a provider's session cookie out of Firefox, on request.
//
// The problem: ollama, mistral and opencode-go authenticate with a browser
// session cookie. Those expire. Every expiry meant noticing the provider had
// gone `auth_expired`, opening devtools, copying the Cookie header by hand,
// and pasting it into the web UI. Firefox already holds a live copy of exactly
// that cookie — so on the rare occasion it goes stale, ask Firefox instead of
// asking the human to transcribe it.
//
// ON DEMAND, NEVER ON A TIMER. An earlier cut re-read Firefox before every
// poll. That was wrong twice over: it gave a long-running daemon a standing
// capability to harvest browser cookies unattended, and it copied a ~2 MB
// database every few minutes to re-learn something that only changes when a
// session expires. The daemon now touches the profile only when a human
// explicitly asks — see Runner.refreshCookieFromFirefox().
//
// Mechanics:
//   - `node:sqlite` (Node 22+) reads cookies.sqlite. Already used by the
//     opencode-go plugin, so no new dependency.
//   - Firefox stores cookie values in PLAINTEXT — no OS-keyring decrypt. (That
//     complexity is Chromium-specific; confirmed on this host 2026-08-16.)
//   - The database is copied to a temp file before opening, because Firefox
//     keeps it in WAL mode while running and a read-only open can fail when
//     SQLite wants to recover the WAL. Copying also guarantees this can never
//     disturb Firefox's own state. The profile is never written to.
//
// Cookie VALUES are secrets: returned to the caller for the outbound request,
// never logged. Log lines here carry counts, hostnames and expiry only.

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './log.js';

function firefoxRoot() {
  return process.env.USAGE_FIREFOX_DIR || path.join(os.homedir(), '.mozilla', 'firefox');
}

// Pick the profile actually in use: prefer `default-release`, then whichever
// cookies.sqlite was modified most recently. A stale `default-esr` profile
// sitting alongside the live one is the common case here, and would otherwise
// hand back cookies that expired months ago.
export function findProfileDb(root = firefoxRoot()) {
  if (!existsSync(root)) return null;
  const candidates = [];
  for (const entry of readdirSync(root)) {
    const db = path.join(root, entry, 'cookies.sqlite');
    if (!existsSync(db)) continue;
    candidates.push({ profile: entry, db, mtime: statSync(db).mtimeMs });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const aDef = a.profile.includes('default-release') ? 1 : 0;
    const bDef = b.profile.includes('default-release') ? 1 : 0;
    if (aDef !== bDef) return bDef - aDef;
    return b.mtime - a.mtime;
  });
  return candidates[0];
}

// Firefox stores host as either `example.com` or `.example.com` (the latter
// meaning "and every subdomain"). Match the domain plus any subdomain, so
// `mistral.ai` picks up `.mistral.ai`, `console.` and `admin.` together — the
// mistral plugin calls two of those hosts, and the pasted cookie that worked
// was always a merge across all of them.
export function hostMatches(cookieHost, domain) {
  const h = String(cookieHost ?? '').replace(/^\./, '').toLowerCase();
  const d = String(domain ?? '').toLowerCase();
  if (!h || !d) return false;
  return h === d || h.endsWith(`.${d}`);
}

// Serialize to what a browser would put in the Cookie header. Later duplicates
// win: rows arrive shortest-host-first, so a subdomain's cookie overrides the
// bare domain's cookie of the same name — the more specific one is what the
// site set for the page being called.
export function toCookieHeader(rows) {
  const seen = new Map();
  for (const r of rows) {
    if (!r?.name) continue;
    seen.set(r.name, r.value ?? '');
  }
  return [...seen.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// Normalize moz_cookies.expiry to epoch SECONDS.
//
// The unit is not stable across Firefox versions: this profile (Firefox 153)
// stores milliseconds — 13 digits, e.g. 1787030245429 — while older profiles
// store seconds. Getting this wrong is not cosmetic: comparing a millisecond
// stamp against a seconds-based `now` makes EVERY cookie look unexpired, which
// silently defeats the expired-cookie filter and hands out a dead header that
// then fails authentication for no visible reason. Observed here 2026-08-18.
//
// Ranges (all far apart, so the guess is unambiguous for any real cookie):
//   < 1e11  seconds       (1e11s is the year 5138; real values ~1.8e9)
//   < 1e14  milliseconds  (~1.787e12 today)
//   else    microseconds  (Firefox uses these for creationTime/lastAccessed)
export function toEpochSeconds(expiry) {
  if (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= 0) return null;
  if (expiry < 1e11) return expiry;
  if (expiry < 1e14) return expiry / 1e3;
  return expiry / 1e6;
}

// Soonest real expiry across the cookies making up the header — i.e. when this
// header starts to degrade. A session cookie (expiry 0) has no date to report.
export function soonestExpiry(rows) {
  const stamps = rows.map((r) => toEpochSeconds(r.expiry)).filter((e) => e != null);
  if (!stamps.length) return null;
  return new Date(Math.min(...stamps) * 1000).toISOString();
}

// Copy the DB (plus its WAL sidecars) somewhere private, read it, clean up.
function readRows(dbPath, domain) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'usage-daemon-cookies-'));
  const copy = path.join(tmpDir, 'cookies.sqlite');
  try {
    copyFileSync(dbPath, copy);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix);
    }
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      // Shortest host first, so bare-domain rows land before the more specific
      // subdomain rows that should override them in toCookieHeader().
      return db
        .prepare(
          `SELECT host, name, value, expiry FROM moz_cookies
            WHERE host LIKE ? OR host LIKE ?
            ORDER BY length(host) ASC`,
        )
        .all(`%${domain}`, `%.${domain}`);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Build the Cookie header for `domain` from Firefox's cookie store.
// Returns { header, expiresAt, count }; `header` is '' when there is nothing
// usable, and the caller reports that to the user rather than storing it.
export function cookieHeaderFor(domain) {
  const empty = { header: '', expiresAt: null, count: 0 };

  const profile = findProfileDb();
  if (!profile) {
    log.warn('firefox cookie source: no profile found', { root: firefoxRoot(), domain });
    return empty;
  }

  let rows;
  try {
    rows = readRows(profile.db, domain);
  } catch (err) {
    log.warn('firefox cookie source: could not read cookie db', {
      domain, profile: profile.profile, err,
    });
    return empty;
  }

  const now = Date.now() / 1000;
  const matching = rows.filter((r) => hostMatches(r.host, domain));
  // A null normalized expiry means a session cookie: Firefox holds it for the
  // life of the browser session and it is perfectly valid to send.
  const live = matching.filter((r) => {
    const exp = toEpochSeconds(r.expiry);
    return exp == null || exp > now;
  });
  const expired = matching.filter((r) => !live.includes(r));
  const header = toCookieHeader(live);

  if (!header) {
    log.warn('firefox cookie source: no live cookies for domain', {
      domain,
      profile: profile.profile,
      matched: matching.length,
      expired: expired.length,
      hint: `log in to ${domain} in Firefox`,
    });
    return empty;
  }

  // Names, never values — enough to see exactly what was handed to the
  // provider (and what was dropped as stale) when a refresh misbehaves.
  log.info('firefox cookie source: built header', {
    domain,
    profile: profile.profile,
    hosts: [...new Set(live.map((r) => r.host))].join(','),
    cookies: live.map((r) => r.name).join(','),
    dropped_expired: expired.length ? expired.map((r) => r.name).join(',') : undefined,
    expires_at: soonestExpiry(live) ?? 'session-only',
  });

  return {
    header,
    expiresAt: soonestExpiry(live),
    count: live.length,
    profile: profile.profile,
    names: live.map((r) => r.name),
  };
}
