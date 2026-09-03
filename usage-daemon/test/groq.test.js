import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, parseDuration, AuthExpiredError } from '../src/providers/groq.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const envelope = readFileSync(path.resolve(here, 'fixtures/groq-ratelimit.json'), 'utf8');

test('parse: builds a single daily_requests window from the envelope, tpm dropped', () => {
  const { windows, tier } = parse(envelope);
  assert.equal(tier, null);
  assert.equal(windows.length, 1);

  const rpd = windows.find((w) => w.id === 'daily_requests');
  assert.ok(Math.abs(rpd.pct - (100 * (1 - 14350 / 14400))) < 1e-9);
  assert.equal(rpd.resets_at, '2026-07-27T13:00:00.000Z');
  assert.equal(rpd.color, '#CC79A7');
  assert.equal(rpd.label, 'Requests/day');

  assert.equal(windows.find((w) => w.id === 'tpm'), undefined);
});

test('parse: only requests header present -> single window', () => {
  const { windows } = parse(
    JSON.stringify({ limit_requests: 100, remaining_requests: 50 }),
  );
  assert.equal(windows.length, 1);
  assert.equal(windows[0].id, 'daily_requests');
  assert.equal(windows[0].label, 'Requests/day');
  assert.equal(windows[0].pct, 50);
});

test('parse: no usable headers throws auth_expired', () => {
  assert.throws(() => parse(JSON.stringify({})), AuthExpiredError);
});

test('parse: unparseable envelope throws auth_expired', () => {
  assert.throws(() => parse('not json'), AuthExpiredError);
});

test('parseDuration: parses Groq duration strings to seconds', () => {
  assert.ok(Math.abs(parseDuration('2m59.56s') - 179.56) < 1e-9);
  assert.ok(Math.abs(parseDuration('1.2s') - 1.2) < 1e-9);
  assert.ok(Math.abs(parseDuration('120ms') - 0.12) < 1e-9);
  assert.ok(Math.abs(parseDuration('45s') - 45) < 1e-9);
  assert.ok(Math.abs(parseDuration('3h2m59.56s') - 10979.56) < 1e-9);
  assert.equal(parseDuration(null), null);
  assert.equal(parseDuration('garbage'), null);
});
