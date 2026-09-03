import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, AuthExpiredError } from '../src/providers/llm7.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, 'fixtures/llm7-quota.json');
const raw = readFileSync(FIXTURE, 'utf8');

test('parse: tier from quota payload', () => {
  const { tier } = parse(raw);
  assert.equal(tier, 'free');
});

test('parse: daily_tokens window with correct values', () => {
  const { windows } = parse(raw);
  assert.equal(windows.length, 1);
  const w = windows[0];
  assert.equal(w.id, 'daily_tokens');
  assert.equal(w.label, 'Tokens');
  assert.equal(w.letter, 'Tk');
  assert.equal(w.used, 2431);
  assert.equal(w.cap, 1000000);
  assert.equal(w.unit, 'tokens');
  assert.equal(w.color, '#56B4E9');
  assert.equal(w.resets_at, null); // rolling 24h window, no fixed boundary
  assert.equal(w.will_deplete, false);
});

test('parse: pct is consumed fraction of the daily cap', () => {
  const { windows } = parse(raw);
  assert.ok(Math.abs(windows[0].pct - 0.2431) < 1e-9); // 2431/1000000 * 100
});

test('parse: _llm7 meta carries the remaining figure', () => {
  const { _llm7 } = parse(raw);
  assert.equal(_llm7.remaining, 997569);
});

test('parse: auth error on data.error throws AuthExpiredError', () => {
  assert.throws(
    () => parse(JSON.stringify({ error: 'invalid_token', message: 'token expired' })),
    AuthExpiredError,
  );
});

test('parse: missing quota figures throws AuthExpiredError', () => {
  assert.throws(() => parse('{}'), AuthExpiredError);
});

test('parse: unparseable JSON throws AuthExpiredError', () => {
  assert.throws(() => parse('not json'), AuthExpiredError);
});
