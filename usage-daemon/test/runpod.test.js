import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, AuthExpiredError } from '../src/providers/runpod.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, 'fixtures/runpod-myself.json');
const raw = readFileSync(FIXTURE, 'utf8');

test('parse: balance window is a bare remaining-count meter, no cap', () => {
  const { windows } = parse(raw);
  assert.equal(windows.length, 1);
  const w = windows[0];
  assert.equal(w.id, 'balance');
  assert.equal(w.used, 12.34);
  assert.equal(w.used_is_remaining, true);
  assert.equal(w.cap, undefined);
  assert.equal(w.pct, null);
  assert.equal(w.unit, 'USD');
  assert.equal(w.will_deplete, false);
});

test('parse: will_deplete true when underBalance is true', () => {
  const { windows } = parse(JSON.stringify({ data: { myself: { clientBalance: 0.5, underBalance: true, minBalance: 5 } } }));
  assert.equal(windows[0].will_deplete, true);
});

test('parse: _runpod meta with raw figures', () => {
  const { _runpod } = parse(raw);
  assert.equal(_runpod.client_balance, 12.34);
  assert.equal(_runpod.under_balance, false);
  assert.equal(_runpod.min_balance, 5);
});

test('parse: graphql errors array throws AuthExpiredError', () => {
  assert.throws(
    () => parse(JSON.stringify({ errors: [{ message: 'invalid api key' }] })),
    AuthExpiredError,
  );
});

test('parse: missing clientBalance throws AuthExpiredError', () => {
  assert.throws(() => parse(JSON.stringify({ data: { myself: {} } })), AuthExpiredError);
});

test('parse: unparseable JSON throws AuthExpiredError', () => {
  assert.throws(() => parse('not json'), AuthExpiredError);
});
