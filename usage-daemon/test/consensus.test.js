import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, AuthExpiredError } from '../src/providers/consensus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, 'fixtures/consensus-client.json');
const raw = readFileSync(FIXTURE, 'utf8');

test('parse: tier is null (not present in Clerk payload)', () => {
  const { tier } = parse(raw);
  assert.equal(tier, null);
});

test('parse: three windows, consumed counts from array lengths', () => {
  const { windows } = parse(raw);
  assert.equal(windows.length, 3);

  const pro = windows.find((w) => w.id === 'pro_messages');
  assert.equal(pro.label, 'Pro Messages');
  assert.equal(pro.used, 2);
  assert.equal(pro.cap, 15);
  assert.ok(Math.abs(pro.pct - (200 / 15)) < 1e-9);
  assert.equal(pro.color, '#E69F00');

  const deep = windows.find((w) => w.id === 'deep_reviews');
  assert.equal(deep.used, 1);
  assert.equal(deep.cap, 3);
  assert.ok(Math.abs(deep.pct - (100 / 3)) < 1e-9);

  const snap = windows.find((w) => w.id === 'snapshots');
  assert.equal(snap.used, 0);
  assert.equal(snap.cap, 10);
  assert.equal(snap.pct, 0);
});

test('parse: resets_at is last_reset_date + 30 days', () => {
  const { windows } = parse(raw);
  assert.equal(windows[0].resets_at, '2026-09-21T22:09:19.529Z');
});

test('parse: _consensus meta with raw figures', () => {
  const { _consensus } = parse(raw);
  assert.equal(_consensus.pro_used, 2);
  assert.equal(_consensus.deep_used, 1);
  assert.equal(_consensus.snapshot_used, 0);
  assert.equal(_consensus.last_reset_date, '2026-08-22T22:09:19.529Z');
});

test('parse: no active session throws AuthExpiredError', () => {
  assert.throws(
    () => parse(JSON.stringify({ response: { sessions: [] } })),
    AuthExpiredError,
  );
});

test('parse: no public_metadata throws AuthExpiredError', () => {
  assert.throws(
    () => parse(JSON.stringify({ response: { sessions: [{ status: 'active', user: {} }] } })),
    AuthExpiredError,
  );
});

test('parse: unparseable JSON throws AuthExpiredError', () => {
  assert.throws(() => parse('not json'), AuthExpiredError);
});
