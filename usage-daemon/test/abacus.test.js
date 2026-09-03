import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, AuthExpiredError } from '../src/providers/abacus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, 'fixtures/abacus-usage.json');
const raw = readFileSync(FIXTURE, 'utf8');

test('parse: tier from org info', () => {
  const { tier } = parse(raw);
  assert.equal(tier, 'free');
});

test('parse: compute points window with correct values', () => {
  const { windows } = parse(raw);
  assert.equal(windows.length, 1);
  const w = windows[0];
  assert.equal(w.id, 'compute_points');
  assert.equal(w.label, 'Credits');
  assert.equal(w.letter, 'Cr');
  assert.equal(w.used, 2000.01);
  assert.equal(w.cap, 2000);
  assert.equal(w.unit, 'credits');
  assert.equal(w.color, '#CC79A7');
  assert.equal(w.resets_at, '2026-09-07T09:01:07+00:00');
  assert.equal(w.will_deplete, false);
});

test('parse: pct caps at 100 when usage exceeds cap', () => {
  const { windows } = parse(raw);
  const w = windows[0];
  assert.equal(w.pct, 100); // 200001/200000 = 100.0005%, clamped to 100
});

test('parse: _abacus meta with figures', () => {
  const { _abacus } = parse(raw);
  assert.equal(_abacus.used, 200001);
  assert.equal(_abacus.cap, 200000);
  assert.equal(_abacus.is_free_tier, true);
  assert.equal(_abacus.free_tier_expires, '2026-09-07T09:01:07+00:00');
});

test('parse: logged-out/missing org throws auth_expired', () => {
  assert.throws(
    () => parse(JSON.stringify({ success: false })),
    AuthExpiredError,
  );
});

test('parse: no compute point info throws auth_expired', () => {
  assert.throws(
    () => parse(JSON.stringify({ success: true, result: { userInfo: { organization: { subscriptionTier: 'free' } } } })),
    AuthExpiredError,
  );
});

test('parse: empty object throws auth_expired', () => {
  assert.throws(() => parse('{}'), AuthExpiredError);
});