import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, AuthExpiredError } from '../src/providers/github.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, 'fixtures/github-rate-limit.json');
const raw = readFileSync(FIXTURE, 'utf8');

test('parse: three windows (core/search/graphql), remaining not consumed', () => {
  const { windows } = parse(raw);
  assert.equal(windows.length, 3);

  const core = windows.find((w) => w.id === 'core');
  assert.equal(core.label, 'REST Calls');
  assert.equal(core.used, 4987); // remaining
  assert.equal(core.used_is_remaining, true);
  assert.equal(core.cap, 5000);
  assert.ok(Math.abs(core.pct - (13 / 5000) * 100) < 1e-9);
  assert.equal(core.resets_at, new Date(1738356858 * 1000).toISOString());

  const search = windows.find((w) => w.id === 'search');
  assert.equal(search.used, 30);
  assert.equal(search.cap, 30);
  assert.equal(search.pct, 0);
});

test('parse: _github meta with raw figures', () => {
  const { _github } = parse(raw);
  assert.equal(_github.core_remaining, 4987);
  assert.equal(_github.core_limit, 5000);
});

test('parse: missing resources throws AuthExpiredError', () => {
  assert.throws(() => parse(JSON.stringify({})), AuthExpiredError);
});

test('parse: unparseable JSON throws AuthExpiredError', () => {
  assert.throws(() => parse('not json'), AuthExpiredError);
});
