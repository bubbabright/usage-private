import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, AuthExpiredError } from '../src/providers/context7.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, 'fixtures/context7-stats.json');
const raw = readFileSync(FIXTURE, 'utf8');

test('parse: tier from ownerPlan', () => {
  const { tier } = parse(raw);
  assert.equal(tier, 'free');
});

test('parse: requests window shows remaining, not consumed', () => {
  const { windows } = parse(raw);
  assert.equal(windows.length, 1);
  const w = windows[0];
  assert.equal(w.id, 'requests');
  assert.equal(w.label, 'Requests/mo');
  assert.equal(w.letter, 'Rq');
  assert.equal(w.used, 997); // remaining = quotaLimit - userRequests = 1000 - 3
  assert.equal(w.used_is_remaining, true);
  assert.equal(w.cap, 1000);
  assert.equal(w.unit, 'requests');
  assert.equal(w.color, '#F0E442'); // Okabe-Ito yellow
  assert.equal(w.resets_at, null);
  assert.equal(w.will_deplete, false);
});

test('parse: pct is consumed fraction of the plan cap', () => {
  const { windows } = parse(raw);
  assert.ok(Math.abs(windows[0].pct - 0.3) < 1e-9); // 3/1000 * 100
});

test('parse: pct is null when quotaLimit is absent', () => {
  const { windows } = parse(
    JSON.stringify({ success: true, data: { userRequests: 5 } }),
  );
  assert.equal(windows[0].pct, null);
  assert.equal(windows[0].cap, null);
});

test('parse: _context7 meta with raw figures', () => {
  const { _context7 } = parse(raw);
  assert.equal(_context7.quotaLimit, 1000);
  assert.equal(_context7.userRequests, 3);
  assert.equal(_context7.ownerPlan, 'free');
  assert.equal(_context7.creditBalance, 0);
});

test('parse: success:false throws AuthExpiredError', () => {
  assert.throws(
    () => parse(JSON.stringify({ success: false })),
    AuthExpiredError,
  );
});

test('parse: missing data throws AuthExpiredError', () => {
  assert.throws(
    () => parse(JSON.stringify({ success: true })),
    AuthExpiredError,
  );
});

test('parse: no userRequests figure throws AuthExpiredError', () => {
  assert.throws(
    () => parse(JSON.stringify({ success: true, data: {} })),
    AuthExpiredError,
  );
});

test('parse: unparseable JSON throws AuthExpiredError', () => {
  assert.throws(() => parse('not json'), AuthExpiredError);
});
