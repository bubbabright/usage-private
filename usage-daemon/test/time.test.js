import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHostIso } from '../src/time.js';

// These assertions are host-timezone-independent: they verify the instant is
// preserved and the shape is valid, not a specific offset.

test('toHostIso: preserves the exact instant (round-trips to same epoch ms)', () => {
  for (const iso of [
    '2026-08-01T00:00:00+00:00',
    '2026-07-16T06:22:02.000Z',
    '2026-12-31T23:59:59-05:00',
  ]) {
    assert.equal(new Date(toHostIso(iso)).getTime(), new Date(iso).getTime());
  }
});

test('toHostIso: output carries an explicit numeric offset (no bare Z)', () => {
  const out = toHostIso('2026-08-01T00:00:00Z');
  assert.match(out, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test('toHostIso: null/empty passes through', () => {
  assert.equal(toHostIso(null), null);
  assert.equal(toHostIso(undefined), undefined);
  assert.equal(toHostIso(''), '');
});

test('toHostIso: unparseable string returned as-is (fail-soft)', () => {
  assert.equal(toHostIso('not a date'), 'not a date');
});

test('toHostIso: matches host wall-clock for a known instant', () => {
  const iso = '2026-08-01T00:00:00Z';
  const d = new Date(iso);
  const out = toHostIso(iso);
  // local wall-clock components must equal what Date reports in the host zone
  const [, Y, Mo, Da, H, Mi, S] = out.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/,
  );
  assert.equal(Number(Y), d.getFullYear());
  assert.equal(Number(Mo), d.getMonth() + 1);
  assert.equal(Number(Da), d.getDate());
  assert.equal(Number(H), d.getHours());
  assert.equal(Number(Mi), d.getMinutes());
  assert.equal(Number(S), d.getSeconds());
});
