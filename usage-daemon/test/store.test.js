// store.js history round-trip + the read cache.
//
// The cache is the part worth pinning down: it must never hand back rows that
// predate an append, and it must survive a file that doesn't exist yet.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'usage-daemon-store-'));
process.env.USAGE_STATE_DIR = tmp; // read at call time by stateDir()

const store = await import('../src/store.js');

const snap = (t, pct) => ({ t, tier: 'pro', windows: [{ id: 'w5h', pct }] });

test('store: read on a provider with no history returns []', async () => {
  assert.deepEqual(await store.read('nobody'), []);
});

test('store: append then read round-trips the compact row shape', async () => {
  await store.append('demo', snap(1000, 12));
  const rows = await store.read('demo');
  assert.deepEqual(rows, [{ t: 1000, tier: 'pro', w5h: 12 }]);
});

test('store: cached read returns the identical array when nothing changed', async () => {
  const a = await store.read('demo');
  const b = await store.read('demo');
  assert.equal(a, b, 'second read is served from cache');
});

test('store: cache is invalidated by an append', async () => {
  await store.append('demo', snap(2000, 34));
  const rows = await store.read('demo');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], { t: 2000, tier: 'pro', w5h: 34 });
});

test('store: historyRow drops windows with no pct', () => {
  const row = store.historyRow({
    t: 5, tier: 'free', windows: [{ id: 'a', pct: 1 }, { id: 'b', pct: null }],
  });
  assert.deepEqual(row, { t: 5, tier: 'free', a: 1 });
});
