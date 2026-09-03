import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, AuthExpiredError } from '../src/providers/serpapi.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const envelope = readFileSync(
  path.resolve(here, 'fixtures/serpapi-account.json'),
  'utf8',
);

test('parse: monthly window shows remaining searches + consumed pct', () => {
  // fixture: 24042 used of 30000 plan -> 80.14% consumed, 5958 left
  const { windows, tier, _serpapi } = parse(envelope);
  assert.equal(tier, null);
  const w = windows.find((x) => x.id === 'monthly_searches');
  assert.ok(Math.abs(w.pct - 80.14) < 1e-9);
  assert.equal(w.used, 5958); // remaining = plan_searches_left
  assert.equal(w.used_is_remaining, true);
  assert.equal(w.cap, 30000);
  assert.equal(w.unit, 'searches');
  assert.equal(w.color, '#E69F00');
  assert.equal(w.resets_at, '2026-09-10');
  assert.equal(_serpapi.plan_searches_left, 5958);
  assert.equal(_serpapi.total_searches_left, 5958);
});

test('parse: no monthly plan -> bare-count meter on total_searches_left', () => {
  const { windows, _serpapi } = parse(
    JSON.stringify({
      account_status: 'Active',
      plan_renewal_date: null,
      searches_per_month: null,
      this_month_usage: null,
      total_searches_left: 1234,
      extra_credits: 100,
    }),
  );
  const w = windows.find((x) => x.id === 'total_searches');
  assert.equal(w.pct, null);
  assert.equal(w.used, 1234);
  assert.equal(w.used_is_remaining, true);
  assert.equal(_serpapi.plan, null);
  assert.equal(_serpapi.total_searches_left, 1234);
});

test('parse: over-limit usage clamps at 100', () => {
  const { windows } = parse(
    JSON.stringify({ searches_per_month: 1000, this_month_usage: 1500 }),
  );
  assert.equal(windows[0].pct, 100);
});

test('parse: error payload throws auth_expired', () => {
  assert.throws(() => parse(JSON.stringify({ error: 'UNAUTHORIZED' })), AuthExpiredError);
});

test('parse: missing figures throws auth_expired', () => {
  assert.throws(() => parse(JSON.stringify({ account_status: 'Active' })), AuthExpiredError);
});

test('parse: unparseable envelope throws auth_expired', () => {
  assert.throws(() => parse('not json'), AuthExpiredError);
});