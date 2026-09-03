import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, AuthExpiredError } from '../src/providers/elevenlabs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, 'fixtures/elevenlabs-subscription.json');
const raw = readFileSync(FIXTURE, 'utf8');

test('parse: tier from tier field', () => {
  const { tier } = parse(raw);
  assert.equal(tier, 'creator');
});

test('parse: characters window shows remaining, cap, reset', () => {
  const { windows } = parse(raw);
  const w = windows.find((w) => w.id === 'characters');
  assert.equal(w.label, 'Characters');
  assert.equal(w.used, 75000); // remaining = 100000 - 25000
  assert.equal(w.used_is_remaining, true);
  assert.equal(w.cap, 100000);
  assert.equal(w.pct, 25); // consumed fraction, unaffected by remaining flip
  assert.equal(w.resets_at, new Date(1738356858 * 1000).toISOString());
  assert.equal(w.color, '#0072B2');
});

test('parse: voice_slots window present when fields exist', () => {
  const { windows } = parse(raw);
  const w = windows.find((w) => w.id === 'voice_slots');
  assert.equal(w.used, 2);
  assert.equal(w.cap, 10);
  assert.equal(w.pct, 20);
});

test('parse: voice_slots window absent when fields missing', () => {
  const { windows } = parse(JSON.stringify({ tier: 'starter', character_count: 1000, character_limit: 10000, status: 'active' }));
  assert.equal(windows.length, 1);
  assert.equal(windows[0].id, 'characters');
});

test('parse: missing character_count throws AuthExpiredError', () => {
  assert.throws(() => parse(JSON.stringify({})), AuthExpiredError);
});

test('parse: unparseable JSON throws AuthExpiredError', () => {
  assert.throws(() => parse('not json'), AuthExpiredError);
});
