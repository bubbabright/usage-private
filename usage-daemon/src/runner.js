// The runner schedules each configured provider on its own interval, normalizes
// its raw parse into the A2 snapshot, stores history, computes will_deplete, and
// keeps the last-known snapshot per provider (fail-soft: errors mark stale, never
// blank).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import { log } from './log.js';
import { cookieHeaderFor } from './cookiejar.js';
import { willDeplete } from './burnrate.js';
import { toHostIso } from './time.js';
import { findActivityBase } from './history-utils.js';

const STATUS = {
  OK: 'ok',
  AUTH_EXPIRED: 'auth_expired',
  RATE_LIMITED: 'rate_limited',
  ERROR: 'error',
};

const MAX_BACKOFF_MS = 60 * 60 * 1000;   // 1h cap on exponential backoff
const AUTH_RECHECK_MS = 30 * 60 * 1000;  // auth_expired: slow re-check so a re-login is picked up without a restart
const FETCH_TIMEOUT_MS = 30 * 1000;      // hard ceiling on a single provider.fetch()
const ACTIVITY_WINDOW_MS = 60 * 60 * 1000; // rolling lookback for the Overview page's activity bar (pct_1h_ago)

// Pure scheduling policy: given the last poll's outcome, how long until the
// next poll. Kept pure (no jitter, no clock) so it unit-tests deterministically;
// the caller adds jitter. `retryAfter` is seconds (from a 429 Retry-After);
// `failures` is the consecutive-failure count (>=1 once failing). This is the
// core of "providers self-heal instead of hammering a throttled endpoint".
export function nextDelay(status, failures, retryAfter, baseMs) {
  if (status === STATUS.OK) return baseMs;
  // Honor an explicit server Retry-After above all else (never poll sooner).
  if (retryAfter != null && retryAfter > 0) {
    return Math.max(retryAfter * 1000, baseMs);
  }
  if (status === STATUS.AUTH_EXPIRED) {
    return Math.max(AUTH_RECHECK_MS, baseMs);
  }
  // rate_limited (no Retry-After) or generic error: exponential backoff,
  // doubling per consecutive failure, floored at base, capped at 1h.
  const n = Math.max(0, (failures ?? 1) - 1);
  const exp = baseMs * 2 ** Math.min(n, 12);
  return Math.min(Math.max(exp, baseMs), MAX_BACKOFF_MS);
}

// Up to +10% (max +30s) of positive jitter so many providers backing off in
// lockstep don't re-poll on the same tick.
function jitter(ms) {
  return Math.floor(Math.random() * Math.min(ms * 0.1, 30_000));
}

// Race a promise against a timeout. The underlying fetch may keep running
// (signal-ignoring scrapers), but the poll no longer blocks forever behind it.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} fetch timed out after ${ms}ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class Runner {
  constructor() {
    this.providers = new Map(); // name -> { provider, timer, cookieFile }
    this.current = new Map();   // name -> snapshot
  }

  add(provider, meta = {}) {
    const name = provider.id;
    this.providers.set(name, {
      provider,
      timer: null,
      cookieFile: meta.cookieFile ?? null,
      // File the daemon persists a pasted token/OAuth payload to, so a
      // webui/extension paste survives a restart the same way cookies do.
      // Whichever *_file the config pointed the secret at (api_token_file,
      // api_key_file, token_file, credentials_path). null => in-memory only.
      authFile: meta.authFile ?? null,
      // Domain to harvest cookies for from Firefox before each poll, or null
      // to use the stored/pasted cookie as before. See cookiejar.js.
      cookieFromFirefox: meta.cookieFromFirefox ?? null,
      // recovery/scheduling state
      scheduled: false,     // true once start() has armed the self-rescheduling chain
      inFlight: null,       // in-flight poll() promise (dedupes concurrent polls)
      failures: 0,          // consecutive failures (0 when healthy)
      retryAfter: null,     // seconds from the last 429 Retry-After, if any
      last_success_t: null, // epoch ms of the last OK poll
      next_poll_at: null,   // epoch ms the next poll is scheduled for
      backoff_ms: null,     // delay chosen for the next poll
    });
  }

  // Persist a session cookie for a provider (daemon stays the owner: it holds,
  // writes, and uses it), reconfigure the plugin, then poll immediately. Lets a
  // client (the extension prefs) supply the cookie without the daemon ever
  // handing it back out. Returns the fresh snapshot.
  async setCookie(name, cookie) {
    const entry = this.providers.get(name);
    if (!entry) throw new Error(`unknown provider: ${name}`);
    const value = String(cookie ?? '').trim();
    if (!value) throw new Error('empty cookie');
    if (entry.cookieFile) {
      await fs.mkdir(path.dirname(entry.cookieFile), { recursive: true });
      await fs.writeFile(entry.cookieFile, value + '\n', { mode: 0o600 });
    }
    entry.provider.configure?.({ cookie: value });
    return this.poll(name, { manual: true });
  }

  // Pull this provider's cookie out of Firefox ONCE, on explicit request, then
  // store it exactly like a pasted one (same file, same lifetime) and re-poll.
  //
  // Deliberately not automatic. An earlier cut re-read Firefox before every
  // poll; that meant the daemon held a standing capability to harvest browser
  // cookies on a timer, and copied a ~2 MB database every few minutes to learn
  // something that only changes when a session expires — weeks apart. Here the
  // daemon touches the browser profile only when a human asks it to, which is
  // also the only moment the answer can have changed (you just logged back in).
  async refreshCookieFromFirefox(name) {
    const entry = this.providers.get(name);
    if (!entry) throw new Error(`unknown provider: ${name}`);
    const domain = entry.cookieFromFirefox;
    if (!domain) {
      throw new Error(`${name} has no cookie_from_firefox domain configured`);
    }
    const { header, expiresAt, count, profile, names } = cookieHeaderFor(domain);
    if (!header) {
      throw new Error(`no live cookies for ${domain} in Firefox — log in to it there first`);
    }
    entry.cookieExpiresAt = expiresAt ?? null;
    log.info('cookie refreshed from firefox', {
      provider: name,
      domain,
      profile,
      cookies: count,
      names: names?.join(','),      // names only — never a value
      expires_at: expiresAt ?? 'session-only',
    });
    const snap = await this.setCookie(name, header);
    // Say plainly whether the fresh cookie actually authenticated. Without
    // this, "refreshed" and "working" look identical in the log right up until
    // someone wonders why the provider is still red.
    if (snap?.status === 'ok') {
      log.info('cookie from firefox accepted', { provider: name, domain });
    } else {
      log.warn('cookie from firefox did NOT authenticate — browser session is dead', {
        provider: name, domain, status: snap?.status, hint: `log in to ${domain} in Firefox`,
      });
    }
    // Shallow copy: report what was done alongside the snapshot without
    // putting this metadata into the stored snapshot, which is the windows[]
    // contract every client reads.
    return {
      ...snap,
      cookie_source: {
        kind: 'firefox',
        domain,
        profile,
        cookies: count,
        names,                                  // names only — never values
        expires_at: expiresAt ?? 'session-only',
      },
    };
  }

  async setAuthPayload(name, payload) {
    const entry = this.providers.get(name);
    if (!entry) throw new Error(`unknown provider: ${name}`);
    const value = String(payload ?? '').trim();
    if (!value) throw new Error('empty payload');
    if (entry.provider.setAuth) {
      await entry.provider.setAuth(value);
    }
    // Persist to the daemon-owned token file so the paste survives a restart
    // (setAuth alone is in-memory only). Cookie providers get this via
    // setCookie/cookieFile; token/OAuth providers get it here via authFile.
    if (entry.authFile) {
      await fs.mkdir(path.dirname(entry.authFile), { recursive: true });
      await fs.writeFile(entry.authFile, value + '\n', { mode: 0o600 });
    }
    return this.poll(name, { manual: true });
  }

  // Flush a stored cookie: delete the on-disk file (if any), clear the
  // in-memory value on the live plugin instance, then poll immediately so
  // the resulting snapshot reflects the cleared state (auth_expired) rather
  // than the last-good one lingering until the next scheduled poll. The
  // empty-string configure() only actually clears anything because provider
  // configure() implementations check `!== undefined`, not truthiness — see
  // the comment at each provider's own configure().
  async clearCookie(name) {
    const entry = this.providers.get(name);
    if (!entry) throw new Error(`unknown provider: ${name}`);
    if (entry.cookieFile) {
      await fs.rm(entry.cookieFile, { force: true });
    }
    entry.provider.configure?.({ cookie: '' });
    return this.poll(name, { manual: true });
  }

  // Purge a stored OAuth-file/token payload: clear the live plugin instance
  // AND delete the daemon-owned authFile (if the config pointed the secret at
  // a *_file), so the cleared state survives a restart — same shape as
  // clearCookie. Re-polls immediately so the snapshot reflects auth_expired.
  async clearAuth(name) {
    const entry = this.providers.get(name);
    if (!entry) throw new Error(`unknown provider: ${name}`);
    if (entry.provider.setAuth) {
      await entry.provider.setAuth('');
    }
    entry.provider.configure?.({ api_key: '' });
    if (entry.authFile) {
      await fs.rm(entry.authFile, { force: true });
    }
    return this.poll(name, { manual: true });
  }

  list() {
    return [...this.providers.keys()].map((name) => {
      const snap = this.current.get(name);
      const entry = this.providers.get(name);
      return {
        provider: name,
        status: snap?.status ?? 'pending',
        stale: snap?.stale ?? true,
        t: snap?.t ?? null,
        tier: snap?.tier ?? null,
        // Additive recovery fields (thin clients may ignore them; windows[]
        // shape is unchanged). Let a UI show "last good Xago / next retry Ys"
        // instead of a frozen stale card with no explanation.
        error: snap?.error ?? null,
        last_success_t: entry?.last_success_t ?? null,
        consecutive_failures: entry?.failures ?? 0,
        next_poll_at: entry?.next_poll_at ?? null,
        // Non-null when this provider can pull its cookie out of Firefox on
        // request (config: cookie_from_firefox = "<domain>"), so the UI offers
        // that button only where it would actually work. cookie_expires_at is
        // whatever the last such refresh reported — null until one happens.
        cookie_from_firefox: entry?.cookieFromFirefox ?? null,
        cookie_expires_at: entry?.cookieExpiresAt ?? null,
        // 'support' = a metered API backing the work (deepgram, firecrawl,
        // serpapi) rather than an AI plan you ration. Surfaced here, not just
        // on /:provider/config, so the overview can group providers onto one
        // shared card without fetching every config separately. Absent =>
        // 'plan', so an untagged plugin keeps its own full card.
        category: entry?.provider.config?.()?.category ?? 'plan',
        // Trimmed windows so the web-ui landing "Overview" can show what's in
        // use across every provider at a glance without fetching each /current.
        windows: (snap?.windows ?? []).map((w) => ({
          id: w.id,
          label: w.label ?? w.id,
          letter: w.letter ?? null,
          pct: typeof w.pct === 'number' ? w.pct : null,
          used: typeof w.used === 'number' ? w.used : null,
          used_is_remaining: !!w.used_is_remaining,
          cap: typeof w.cap === 'number' ? w.cap : null,
          unit: w.unit ?? null,
          color: w.color ?? null,
          cycles_remaining: typeof w.cycles_remaining === 'number' ? w.cycles_remaining : null,
          resets_at: w.resets_at ?? null,
          will_deplete: !!w.will_deplete,
          pct_1h_ago: typeof w.pct_1h_ago === 'number' ? w.pct_1h_ago : null,
        })),
      };
    });
  }

  getCurrent(name) {
    return this.current.get(name) ?? null;
  }

  async getHistory(name) {
    return store.read(name);
  }

  start() {
    for (const { provider } of this.providers.values()) {
      const entry = this.providers.get(provider.id);
      entry.scheduled = true;
      // Poll once immediately; poll()'s finally() arms the next timer based on
      // the outcome (self-rescheduling chain, not a fixed interval).
      this.poll(provider.id);
    }
  }

  stop() {
    for (const entry of this.providers.values()) {
      entry.scheduled = false;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  // Arm the next poll for a provider based on its last snapshot + failure state.
  _reschedule(name) {
    const entry = this.providers.get(name);
    if (!entry || !entry.scheduled) return;
    const snap = this.current.get(name);
    const base = (entry.provider.intervalSeconds?.() ?? 300) * 1000;
    const status = snap?.status ?? STATUS.ERROR;
    const delay = nextDelay(status, entry.failures, entry.retryAfter, base) + jitter(base);
    entry.backoff_ms = delay;
    entry.next_poll_at = Date.now() + delay;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.poll(name), delay);
    if (entry.timer.unref) entry.timer.unref();
  }

  // Poll one provider now. Dedupes concurrent callers (scheduled tick +
  // manual /refresh) onto one in-flight fetch, then re-arms the schedule.
  //
  // `manual: true` marks a user-initiated call (refresh button, cookie/auth
  // paste or clear) — these bypass the backoff gate below on purpose: a user
  // acting right now is a stronger signal than a stale schedule, and unlike a
  // scheduled tick a human won't spam it in a tight loop. Applies uniformly
  // to every provider since this is the one shared poll() they all go
  // through — no per-provider gate to duplicate for new providers.
  async poll(name, { manual = false } = {}) {
    const entry = this.providers.get(name);
    if (!entry) throw new Error(`unknown provider: ${name}`);
    // Respect an active 429 Retry-After for scheduled polls: never re-hit a
    // throttled endpoint before its window elapses on a background tick.
    // Manual calls (see above) skip this — that's the fix for a "Force Poll"
    // button that used to just hand back the same stale snapshot for up to
    // an hour after one 429.
    if (
      !manual &&
      this.current.get(name)?.status === STATUS.RATE_LIMITED &&
      entry.retryAfter &&
      entry.next_poll_at &&
      Date.now() < entry.next_poll_at
    ) {
      return this.current.get(name) ?? null;
    }
    if (entry.inFlight) return entry.inFlight;
    entry.inFlight = this._doPoll(name);
    try {
      return await entry.inFlight;
    } finally {
      entry.inFlight = null;
      this._reschedule(name);
    }
  }

  async _doPoll(name) {
    const entry = this.providers.get(name);
    const { provider } = entry;
    const t = Date.now();
    try {
      const raw = await withTimeout(provider.fetch(), FETCH_TIMEOUT_MS, name);
      const parsed = provider.parse(raw); // { tier, windows, segments }
      const history = await store.read(name);
      const windows = parsed.windows.map((w) => {
        const resets_at = toHostIso(w.resets_at); // one representation for all providers
        // Rolling activity lookback for the Overview page's two-tone bar:
        // last hour, or since the window's last reset, whichever is shorter
        // — a window that reset 15 minutes ago compares against 15 minutes
        // of real activity instead of going flat for the rest of the hour.
        // Null (not a negative sliver) only when there's no history at all
        // yet (brand new provider).
        const base = typeof w.pct === 'number'
          ? findActivityBase(history, w.id, t, ACTIVITY_WINDOW_MS)
          : null;
        const pct_1h_ago = base && base.value <= w.pct ? base.value : null;
        return {
          ...w,
          resets_at,
          will_deplete: willDeplete(history, w.id, w.pct, resets_at, t),
          pct_1h_ago,
        };
      });
      const meta = provider.meta?.() ?? {}; // optional hook; undefined for ollama today
      if (meta.token_expires_at) meta.token_expires_at = toHostIso(meta.token_expires_at);
      const snapshot = {
        provider: name,
        t,
        tier: parsed.tier,
        status: STATUS.OK,
        stale: false,
        windows,
        segments: parsed.segments ?? [],
        ...meta,
      };
      if (entry.failures > 0) {
        log.info('provider recovered', { provider: name, after_failures: entry.failures });
      }
      entry.failures = 0;
      entry.retryAfter = null;
      entry.last_success_t = t;
      this.current.set(name, snapshot);
      await store.append(name, snapshot);
      return snapshot;
    } catch (err) {
      // Self-heal an expired session, once, before giving up.
      //
      // A cookie provider goes auth_expired because the session lapsed — which
      // happens precisely because you stopped using it. Resuming use means
      // logging in again in the browser, and at that moment Firefox holds a
      // valid cookie. So the credential the daemon needs already exists; it
      // just has to look. Using the provider is what fixes it.
      //
      // Note this is NOT the per-poll harvest that was rejected earlier: a
      // healthy provider never reaches this branch, so a working daemon reads
      // the browser profile zero times. It fires only while a provider is
      // broken, at the auth_expired recheck cadence (~30 min), and only until
      // it recovers. The `!==` guard means a cookie already known to be dead
      // is not retried at all — no read, no fetch — until Firefox has a
      // genuinely different one, i.e. until you have actually logged back in.
      if (err?.code === 'auth_expired' && entry.cookieFromFirefox && !entry.firefoxRecovery) {
        entry.firefoxRecovery = true;
        try {
          const fresh = cookieHeaderFor(entry.cookieFromFirefox);
          if (fresh.header && fresh.header !== entry.lastFirefoxCookie) {
            entry.lastFirefoxCookie = fresh.header;
            entry.cookieExpiresAt = fresh.expiresAt ?? null;
            provider.configure?.({ cookie: fresh.header });
            // Persist like a pasted cookie so the recovery survives a restart.
            if (entry.cookieFile) {
              await fs.mkdir(path.dirname(entry.cookieFile), { recursive: true });
              await fs.writeFile(entry.cookieFile, fresh.header + '\n', { mode: 0o600 });
            }
            log.info('auth_expired: found a newer cookie in firefox, retrying poll', {
              provider: name,
              domain: entry.cookieFromFirefox,
              cookies: fresh.count,
              expires_at: fresh.expiresAt ?? 'session-only',
            });
            return await this._doPoll(name); // one retry, guarded against recursion
          }
        } catch (recoveryErr) {
          log.warn('auth_expired: firefox recovery attempt failed', {
            provider: name, domain: entry.cookieFromFirefox, err: recoveryErr,
          });
        } finally {
          entry.firefoxRecovery = false;
        }
      }
      return this._markStale(name, t, err);
    }
  }

  // Keep last-known values, flag stale + status. Never blank.
  //
  // `prev` only covers snapshots THIS process has produced — a daemon
  // restart wipes it even though the provider may have years of good polls
  // on disk. Without a disk fallback, a provider whose auth already expired
  // *before* a restart (nothing to re-populate `current` with) renders as
  // empty forever, even though store.js has its last-known percentages.
  // Disk history rows are compact (`{t, tier, <window.id>: pct}`, no
  // label/color/resets_at — see store.js historyRow), so windows rebuilt
  // from disk borrow label/color from the provider's own static config()
  // and leave resets_at null (the old value would be stale past meaning,
  // not just imprecise) and will_deplete false (nothing to project from a
  // single point).
  async _markStale(name, t, err) {
    const prev = this.current.get(name);
    const status =
      err?.code === 'auth_expired'
        ? STATUS.AUTH_EXPIRED
        : err?.code === 'rate_limited'
          ? STATUS.RATE_LIMITED
          : STATUS.ERROR;

    // Track consecutive failures + any server Retry-After so _reschedule can
    // back off instead of hammering. Log every failure (ends the silent rot
    // where a provider fell off and nobody could see why).
    const entry = this.providers.get(name);
    if (entry) {
      entry.failures = (entry.failures ?? 0) + 1;
      entry.retryAfter =
        typeof err?.retryAfter === 'number' && err.retryAfter > 0 ? err.retryAfter : null;
      // Log the stack at debug level: the one-line message is enough for the
      // routine auth_expired/429 churn, but a genuine crash-adjacent error
      // (a provider throwing something unexpected) needs the stack to place.
      log.warn('provider poll failed', {
        provider: name,
        status,
        error: err?.message ?? String(err),
        consecutive_failures: entry.failures,
        retry_after_s: entry.retryAfter ?? undefined,
      });
      if (status === STATUS.ERROR && err?.stack) {
        log.debug('provider poll failure detail', { provider: name, err });
      }
    }

    let windows = prev?.windows ?? null;
    let tier = prev?.tier ?? null;
    let lastT = prev?.t ?? null;
    if (windows == null) {
      const history = await store.read(name);
      const last = history[history.length - 1];
      if (last) {
        const entry = this.providers.get(name);
        const cfgWindows = entry?.provider.config?.()?.windows ?? [];
        const cfgById = new Map(cfgWindows.map((w) => [w.id, w]));
        windows = Object.keys(last)
          .filter((k) => k !== 't' && k !== 'tier')
          .map((id) => ({
            id,
            label: cfgById.get(id)?.label ?? id,
            pct: last[id],
            resets_at: null,
            color: cfgById.get(id)?.color ?? null,
            will_deplete: false,
          }));
        tier = last.tier ?? tier;
        lastT = last.t ?? lastT;
      }
    }

    const snapshot = {
      provider: name,
      t: lastT ?? t, // keep the last *successful* timestamp if we have one
      tier: tier ?? 'unknown',
      status,
      stale: true,
      error: err?.message ?? String(err),
      windows: windows ?? [],
      segments: prev?.segments ?? [],
    };
    this.current.set(name, snapshot);
    return snapshot;
  }
}