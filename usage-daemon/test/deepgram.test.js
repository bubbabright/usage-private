import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, AuthExpiredError } from '../src/providers/deepgram.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Vendored balances response shape (amounts synthetic, PO ids scrubbed).
const balancesBody = JSON.parse(
  readFileSync(path.resolve(here, 'fixtures/deepgram-balances.json'), 'utf8'),
);

// fetch() ships an envelope { balances, projects, cap }.
const envelope = (cap = null) =>
  JSON.stringify({ balances: balancesBody.balances, projects: 1, cap });

test('parse: sums balances into a remaining dollar figure (pct null without cap)', () => {
  const { windows, _balance } = parse(envelope());
  const w = windows.find((x) => x.id === 'balance');
  assert.equal(w.pct, null); // balance meter, no percentage without a cap
  assert.equal(w.resets_at, null);
  assert.equal(w.color, '#009E73');
  assert.ok(Math.abs(_balance.amount - 12.75) < 1e-9);
  assert.equal(_balance.units, 'USD');
});

test('parse: with balance_cap -> used percentage', () => {
  // cap 51 USD, 12.75 remaining -> 38.25 used -> 75% used
  const { windows } = parse(envelope(51));
  assert.ok(Math.abs(windows[0].pct - 75) < 1e-9);
});

test('parse: used pct clamps at 0 when topped up beyond cap', () => {
  const { windows } = parse(JSON.stringify({ balances: [{ amount: 100, units: 'USD' }], cap: 50 }));
  assert.equal(windows[0].pct, 0);
});

test('parse: empty balances = $0 remaining (valid, not an error)', () => {
  const { windows, _balance } = parse(JSON.stringify({ balances: [], cap: 50 }));
  assert.equal(_balance.amount, 0);
  assert.equal(windows[0].pct, 100); // fully depleted against the cap
});

test('parse: err_code payload throws auth_expired', () => {
  assert.throws(
    () => parse(JSON.stringify({ err_code: 'INSUFFICIENT_PERMISSIONS', err_msg: 'need usage:read' })),
    AuthExpiredError,
  );
});

test('parse: missing balances array throws auth_expired', () => {
  assert.throws(() => parse(JSON.stringify({ projects: 1 })), AuthExpiredError);
});

test('parse: the balance window carries the dollar figure, not just a pct', () => {
  // Regression: the window used to be {pct: null} with no `used`/`unit`, so a
  // healthy prepaid account rendered as an empty bar with no number at all.
  const { windows } = parse(JSON.stringify({
    balances: [{ amount: 12.5, units: 'usd' }, { amount: 2.5, units: 'usd' }],
    projects: 1,
    cap: null,
  }));
  const bal = windows.find((w) => w.id === 'balance');
  assert.equal(bal.pct, null, 'no declared cap -> no percentage');
  assert.equal(bal.used, 15, 'balances are summed across the account');
  assert.equal(bal.used_is_remaining, true);
  assert.equal(bal.unit, 'usd');
  assert.equal(bal.cap, null);
});

test('parse: a declared balance_cap turns the balance into a percentage too', () => {
  const { windows } = parse(JSON.stringify({
    balances: [{ amount: 150, units: 'usd' }],
    projects: 1,
    cap: 200,
  }));
  const bal = windows.find((w) => w.id === 'balance');
  assert.equal(bal.pct, 25, '50 of 200 consumed');
  assert.equal(bal.used, 150, 'used still reports what remains');
  assert.equal(bal.cap, 200);
});
