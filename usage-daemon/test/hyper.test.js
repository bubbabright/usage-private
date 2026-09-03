import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, parseRefreshText, AuthExpiredError } from '../src/providers/hyper.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, 'fixtures/hyper-credits.json');
const raw = readFileSync(FIXTURE, 'utf8');

test('parse: tier is free', () => {
  const { tier } = parse(raw);
  assert.equal(tier, 'free');
});

test('parse: hypercredits window with correct values', () => {
  const { windows } = parse(raw);
  assert.equal(windows.length, 1);
  const w = windows[0];
  assert.equal(w.id, 'hypercredits');
  assert.equal(w.label, 'Credits');
  assert.equal(w.letter, 'Hc');
  assert.equal(w.used, 22);  // 100 - 78
  assert.equal(w.cap, 100);
  assert.equal(w.unit, 'credits');
  assert.equal(w.color, '#0072B2');
  assert.equal(w.pct, 22);  // 22/100
});

test('parse: _hyper meta with balance', () => {
  const { _hyper } = parse(raw);
  assert.equal(_hyper.balance, 78);
});

test('parse: 0 balance shows 100% used', () => {
  const { windows } = parse('{"balance": 0}');
  assert.equal(windows[0].used, 100);
  assert.equal(windows[0].pct, 100);
});

test('parse: full balance (100) shows 0% used', () => {
  const { windows } = parse('{"balance": 100}');
  assert.equal(windows[0].used, 0);
  assert.equal(windows[0].pct, 0);
});

test('parse: auth error throws AuthExpiredError', () => {
  assert.throws(
    () => parse(JSON.stringify({ error: { message: 'invalid key', type: 'authentication_error' } })),
    AuthExpiredError,
  );
});

test('parse: empty object throws AuthExpiredError', () => {
  assert.throws(() => parse('{}'), AuthExpiredError);
});

test('parseRefreshText: 4 weeks', () => {
  const iso = parseRefreshText('Next Hypercredit Refresh in 4 weeks');
  assert.ok(iso);
  const d = new Date(iso);
  const now = Date.now();
  // 4 weeks = 28 days, within a 1s tolerance
  assert.ok(d.getTime() > now + 27 * 86400000);
  assert.ok(d.getTime() < now + 29 * 86400000);
});

test('parseRefreshText: 1 week', () => {
  const iso = parseRefreshText('Next Hypercredit Refresh in 1 week');
  assert.ok(iso);
  const d = new Date(iso);
  const now = Date.now();
  assert.ok(d.getTime() > now + 6 * 86400000);
  assert.ok(d.getTime() < now + 8 * 86400000);
});

test('parseRefreshText: 2 days', () => {
  const iso = parseRefreshText('Next Hypercredit Refresh in 2 days');
  assert.ok(iso);
  const d = new Date(iso);
  const now = Date.now();
  assert.ok(d.getTime() > now + 1 * 86400000);
  assert.ok(d.getTime() < now + 3 * 86400000);
});

test('parseRefreshText: no match returns null', () => {
  assert.equal(parseRefreshText('<html>no refresh text here</html>'), null);
});