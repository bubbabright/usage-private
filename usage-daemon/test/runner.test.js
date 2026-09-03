import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// isolate history + state writes to a throwaway dir
const tmp = mkdtempSync(path.join(os.tmpdir(), 'usage-daemon-test-'));
process.env.XDG_STATE_HOME = path.join(tmp, 'state');

const { Runner, nextDelay } = await import('../src/runner.js');

const BASE = 300_000; // 5 min

test('nextDelay: ok returns base interval', () => {
  assert.equal(nextDelay('ok', 0, null, BASE), BASE);
});

test('nextDelay: rate_limited honors Retry-After (never sooner than it, above base)', () => {
  // 600s retry-after > base -> 600s
  assert.equal(nextDelay('rate_limited', 1, 600, BASE), 600_000);
  // tiny retry-after still floored to base
  assert.equal(nextDelay('rate_limited', 1, 10, BASE), BASE);
});

test('nextDelay: error without Retry-After backs off exponentially, floored/capped', () => {
  assert.equal(nextDelay('error', 1, null, BASE), BASE);        // 1st failure = base
  assert.equal(nextDelay('error', 2, null, BASE), 2 * BASE);    // doubles
  assert.equal(nextDelay('error', 3, null, BASE), 4 * BASE);
  assert.equal(nextDelay('error', 99, null, BASE), 60 * 60 * 1000); // capped at 1h
});

test('nextDelay: auth_expired uses slow re-check cadence (>= base)', () => {
  assert.equal(nextDelay('auth_expired', 5, null, BASE), 30 * 60 * 1000);
});

test('poll: in-flight guard dedupes concurrent polls onto one fetch', async () => {
  let fetches = 0;
  const runner = new Runner();
  runner.add({
    id: 'slow',
    label: 'Slow',
    auth: { kind: 'cookie' },
    async fetch() {
      fetches++;
      await new Promise((r) => setTimeout(r, 30));
      return 'x';
    },
    parse() {
      return { tier: null, windows: [], segments: [] };
    },
  });
  const [a, b] = await Promise.all([runner.poll('slow'), runner.poll('slow')]);
  assert.equal(fetches, 1);       // second call rode the first fetch
  assert.equal(a, b);             // same snapshot object
});

test('poll: failure then recovery clears failure count + sets last_success_t', async () => {
  let ok = false;
  const runner = new Runner();
  runner.add({
    id: 'flap',
    label: 'Flap',
    auth: { kind: 'cookie' },
    async fetch() {
      if (!ok) {
        const e = new Error('down');
        e.code = 'error';
        throw e;
      }
      return 'x';
    },
    parse() {
      return { tier: null, windows: [], segments: [] };
    },
  });
  const bad = await runner.poll('flap');
  assert.equal(bad.status, 'error');
  assert.equal(runner.providers.get('flap').failures, 1);
  ok = true;
  const good = await runner.poll('flap');
  assert.equal(good.status, 'ok');
  assert.equal(runner.providers.get('flap').failures, 0);
  assert.ok(runner.providers.get('flap').last_success_t > 0);
});

test('poll: manual bypasses an active Retry-After gate; scheduled poll respects it', async () => {
  let fetches = 0;
  const runner = new Runner();
  runner.add({
    id: 'throttled',
    label: 'Throttled',
    auth: { kind: 'cookie' },
    async fetch() {
      fetches++;
      const e = new Error('rate_limited');
      e.code = 'rate_limited';
      e.retryAfter = 600; // seconds
      throw e;
    },
    parse() {
      return { tier: null, windows: [], segments: [] };
    },
  });
  runner.providers.get('throttled').scheduled = true; // arm _reschedule, as start() would

  const first = await runner.poll('throttled');
  assert.equal(first.status, 'rate_limited');
  assert.equal(fetches, 1);
  assert.ok(runner.providers.get('throttled').next_poll_at > Date.now());

  // Scheduled/background poll before next_poll_at: gate holds, no re-fetch.
  const cached = await runner.poll('throttled');
  assert.equal(fetches, 1);
  assert.equal(cached, first);

  // Manual (user-initiated) poll: bypasses the gate, re-fetches immediately.
  const manual = await runner.poll('throttled', { manual: true });
  assert.equal(fetches, 2);
  assert.equal(manual.status, 'rate_limited');
});

// A stub provider matching the new HANDOFF-14 interface: id, label, auth, fetch, parse
function stubProvider() {
  let cookie = null;
  return {
    id: 'stub',
    label: 'Stub Provider',
    auth: { kind: 'cookie' },
    configure(cfg = {}) {
      if (cfg.cookie !== undefined) cookie = cfg.cookie;
    },
    async fetch() {
      if (!cookie) {
        const e = new Error('no cookie');
        e.code = 'auth_expired';
        throw e;
      }
      // Return raw HTML-like string that parse() will handle
      return 'Cloud usage <span class="capitalize">free</span>';
    },
    parse(raw) {
      return {
        tier: 'free',
        windows: [
          { id: 'session', label: 'Session', pct: 5, resets_at: null, color: '#E69F00', will_deplete: false },
        ],
        segments: [],
      };
    },
  };
}

test('setCookie: persists to cookieFile (0600), reconfigures plugin, re-polls', async () => {
  const cookieFile = path.join(tmp, 'stub.cookie');
  const runner = new Runner();
  runner.add(stubProvider(), { cookieFile });

  // before a cookie: poll fails soft to auth_expired, stays alive
  const before = await runner.poll('stub');
  assert.equal(before.status, 'auth_expired');
  assert.equal(before.stale, true);

  // supply the cookie via the daemon (as the HTTP endpoint would)
  const snap = await runner.setCookie('stub', '  session=abc123  ');

  assert.equal(snap.status, 'ok');
  assert.equal(snap.stale, false);
  assert.equal(snap.windows[0].pct, 5);

  // cookie was written, trimmed, owner-only perms
  const written = readFileSync(cookieFile, 'utf8');
  assert.equal(written, 'session=abc123\n');
  const mode = statSync(cookieFile).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('setCookie: empty cookie rejected', async () => {
  const runner = new Runner();
  runner.add(stubProvider(), { cookieFile: path.join(tmp, 'x.cookie') });
  await assert.rejects(() => runner.setCookie('stub', '   '), /empty cookie/);
});

test('clearCookie: removes cookie file, reconfigures plugin, re-polls to auth_expired', async () => {
  const cookieFile = path.join(tmp, 'flush.cookie');
  const runner = new Runner();
  runner.add(stubProvider(), { cookieFile });

  const ok = await runner.setCookie('stub', 'session=abc123');
  assert.equal(ok.status, 'ok');
  assert.equal(readFileSync(cookieFile, 'utf8'), 'session=abc123\n');

  const flushed = await runner.clearCookie('stub');
  assert.equal(flushed.status, 'auth_expired');
  assert.equal(flushed.stale, true);
  assert.throws(() => readFileSync(cookieFile, 'utf8'));
});

// Token providers (cloudflare/openrouter/deepgram/groq/firecrawl): a pasted
// token must persist to the daemon-owned authFile so it survives a restart,
// mirroring the cookie path. setAuth updates the live plugin; authFile is the
// on-disk copy config.js re-reads on next boot.
function tokenStubProvider() {
  let token = null;
  return {
    id: 'stub',
    label: 'Token Stub',
    auth: { kind: 'token' },
    setAuth(t) { token = t ? String(t).trim() : null; },
    async fetch() {
      if (!token) { const e = new Error('no token'); e.code = 'auth_expired'; throw e; }
      return 'ok';
    },
    parse() {
      return { tier: null, windows: [{ id: 'x', label: 'X', pct: 1, resets_at: null, color: '#000', will_deplete: false }], segments: [] };
    },
  };
}

test('setAuthPayload: persists token to authFile (0600) so it survives restart', async () => {
  const authFile = path.join(tmp, 'stub.token');
  const runner = new Runner();
  runner.add(tokenStubProvider(), { authFile });

  const before = await runner.poll('stub');
  assert.equal(before.status, 'auth_expired');

  const snap = await runner.setAuthPayload('stub', '  tok-abc123  ');
  assert.equal(snap.status, 'ok');

  // trimmed, written, owner-only perms — a fresh boot re-reads this file
  assert.equal(readFileSync(authFile, 'utf8'), 'tok-abc123\n');
  assert.equal(statSync(authFile).mode & 0o777, 0o600);
});

test('clearAuth: removes authFile and re-polls to auth_expired', async () => {
  const authFile = path.join(tmp, 'clear.token');
  const runner = new Runner();
  runner.add(tokenStubProvider(), { authFile });

  await runner.setAuthPayload('stub', 'tok-abc123');
  assert.equal(readFileSync(authFile, 'utf8'), 'tok-abc123\n');

  const flushed = await runner.clearAuth('stub');
  assert.equal(flushed.status, 'auth_expired');
  assert.throws(() => readFileSync(authFile, 'utf8'));
});

test('setAuthPayload: no authFile => in-memory only, no file written', async () => {
  const runner = new Runner();
  runner.add(tokenStubProvider(), {}); // no authFile
  const snap = await runner.setAuthPayload('stub', 'tok-abc123');
  assert.equal(snap.status, 'ok'); // still works live, just not persisted
});