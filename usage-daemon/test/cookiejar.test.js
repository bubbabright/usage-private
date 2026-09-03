// cookiejar.js — the pure parts: which stored cookies belong to a domain, how
// they serialize into a Cookie header, and when that header starts to degrade.
//
// Fixtures mirror the real rows observed in Firefox's moz_cookies on this host
// (2026-08-16 probe): mistral spreads cookies across `.mistral.ai`, `console.`,
// `admin.` and `chat.`; ollama has `ollama.com` plus an unrelated
// `signin.ollama.com` set; opencode keeps its session on `opencode.ai`.

import test from 'node:test';
import assert from 'node:assert/strict';

const { hostMatches, toCookieHeader, soonestExpiry, toEpochSeconds } = await import('../src/cookiejar.js');

// moz_cookies.expiry unit varies by Firefox version. This profile (FF 153)
// stores MILLISECONDS; older ones store seconds. Comparing a millisecond stamp
// against a seconds-based clock makes every cookie look unexpired, which
// silently defeats the expired-cookie filter — the bug this guards.
test('toEpochSeconds: passes through a seconds stamp unchanged', () => {
  assert.equal(toEpochSeconds(1_787_030_245), 1_787_030_245);
});

test('toEpochSeconds: converts the millisecond stamps Firefox 153 stores', () => {
  // Real value observed in this profile for a __cf_bm cookie.
  assert.equal(toEpochSeconds(1_787_030_245_429), 1_787_030_245.429);
});

test('toEpochSeconds: converts microsecond stamps', () => {
  assert.equal(toEpochSeconds(1_787_030_245_429_000), 1_787_030_245.429);
});

test('toEpochSeconds: session cookies and junk have no expiry', () => {
  for (const v of [0, -1, null, undefined, NaN, Infinity, 'soon']) {
    assert.equal(toEpochSeconds(v), null, String(v));
  }
});

test('toEpochSeconds: a millisecond stamp is not mistaken for a far-future date', () => {
  // The original bug: 1.787e12 read as seconds lands in the year 58598.
  const asSeconds = new Date(1_787_030_245_429 * 1000).getUTCFullYear();
  assert.ok(asSeconds > 50_000, 'sanity: the naive reading really is absurd');
  const fixed = new Date(toEpochSeconds(1_787_030_245_429) * 1000).getUTCFullYear();
  assert.equal(fixed, 2026);
});

test('hostMatches: exact domain', () => {
  assert.equal(hostMatches('ollama.com', 'ollama.com'), true);
});

test('hostMatches: leading-dot domain cookie covers the bare domain', () => {
  assert.equal(hostMatches('.mistral.ai', 'mistral.ai'), true);
});

test('hostMatches: subdomains belong to the domain', () => {
  for (const h of ['console.mistral.ai', 'admin.mistral.ai', 'chat.mistral.ai']) {
    assert.equal(hostMatches(h, 'mistral.ai'), true, h);
  }
});

test('hostMatches: a different registrable domain never matches', () => {
  assert.equal(hostMatches('notmistral.ai', 'mistral.ai'), false);
  assert.equal(hostMatches('mistral.ai.evil.com', 'mistral.ai'), false);
  assert.equal(hostMatches('ollama.com', 'mistral.ai'), false);
});

test('hostMatches: empty/garbage input is not a match', () => {
  for (const [h, d] of [['', 'mistral.ai'], [null, 'mistral.ai'], ['mistral.ai', ''], [undefined, undefined]]) {
    assert.equal(hostMatches(h, d), false);
  }
});

test('toCookieHeader: serializes name=value pairs joined with "; "', () => {
  const header = toCookieHeader([
    { name: 'aid', value: 'A1' },
    { name: '__Secure-session', value: 'S1' },
  ]);
  assert.equal(header, 'aid=A1; __Secure-session=S1');
});

test('toCookieHeader: later (more specific host) rows win on duplicate names', () => {
  // Rows arrive shortest-host-first, so the subdomain's csrftoken should win.
  const header = toCookieHeader([
    { name: 'csrftoken', value: 'from-bare-domain' },
    { name: 'csrftoken', value: 'from-console-subdomain' },
  ]);
  assert.equal(header, 'csrftoken=from-console-subdomain');
});

test('toCookieHeader: skips nameless rows and tolerates a missing value', () => {
  const header = toCookieHeader([
    { name: '', value: 'x' },
    { name: null, value: 'y' },
    { name: 'oc_locale' },
  ]);
  assert.equal(header, 'oc_locale=');
});

test('toCookieHeader: empty input yields an empty header, not "undefined"', () => {
  assert.equal(toCookieHeader([]), '');
});

test('soonestExpiry: reports the earliest real expiry as ISO', () => {
  const later = 2_000_000_000;
  const sooner = 1_900_000_000;
  const iso = soonestExpiry([{ expiry: later }, { expiry: sooner }]);
  assert.equal(iso, new Date(sooner * 1000).toISOString());
});

test('soonestExpiry: normalizes millisecond rows to a sane year', () => {
  const iso = soonestExpiry([{ expiry: 1_787_030_245_429 }, { expiry: 1_787_111_197_664 }]);
  assert.equal(new Date(iso).getUTCFullYear(), 2026);
  assert.equal(iso, new Date(1_787_030_245.429 * 1000).toISOString());
});

test('soonestExpiry: mixed seconds and millisecond rows compare on one scale', () => {
  // seconds row is the earlier one; the ms row must not win by being a bigger number
  const iso = soonestExpiry([{ expiry: 1_787_111_197_664 }, { expiry: 1_787_030_245 }]);
  assert.equal(iso, new Date(1_787_030_245 * 1000).toISOString());
});

test('soonestExpiry: session cookies (expiry 0) have no date to report', () => {
  assert.equal(soonestExpiry([{ expiry: 0 }, { expiry: undefined }]), null);
  assert.equal(soonestExpiry([]), null);
});

test('soonestExpiry: ignores session cookies when a real expiry is present', () => {
  const real = 1_900_000_000;
  assert.equal(soonestExpiry([{ expiry: 0 }, { expiry: real }]), new Date(real * 1000).toISOString());
});
