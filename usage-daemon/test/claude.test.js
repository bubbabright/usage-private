import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, AuthExpiredError } from '../src/providers/claude.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// PII-scrubbed sample shaped like GET https://api.anthropic.com/api/oauth/usage.
const FIXTURE = path.resolve(here, 'fixtures/claude-usage.json');
const raw = readFileSync(FIXTURE, 'utf8');

test('parse: session (5h) + weekly (7d) windows with correct pct/resets/letter', () => {
  const { windows } = parse(raw);
  const session = windows.find((w) => w.id === 'session');
  const weekly = windows.find((w) => w.id === 'weekly');

  assert.equal(session.pct, 12);
  assert.equal(session.resets_at, '2026-07-13T18:00:00Z');
  assert.equal(session.letter, '5h');
  assert.equal(session.color, '#E69F00');

  assert.equal(weekly.pct, 34);
  assert.equal(weekly.resets_at, '2026-07-18T00:00:00Z');
  assert.equal(weekly.letter, 'Wk');
  assert.equal(weekly.color, '#56B4E9');
});

test('parse: tier is null (claude has no tier concept)', () => {
  const { tier } = parse(raw);
  assert.equal(tier, null);
});

test('parse: no segments (claude has no per-model segment breakdown)', () => {
  const { segments } = parse(raw);
  assert.deepEqual(segments, []);
});

test('parse: extra_usage becomes a Usage Credits window when enabled', () => {
  const body = JSON.stringify({
    five_hour: { utilization: 100, resets_at: '2026-07-23T20:50:00Z' },
    seven_day: { utilization: 92, resets_at: '2026-07-24T14:00:00Z' },
    extra_usage: {
      is_enabled: true,
      monthly_limit: 2000,
      used_credits: 1361,
      utilization: 68.05,
      currency: 'USD',
      decimal_places: 2,
    },
  });
  const { windows } = parse(body);
  assert.equal(windows.length, 3);
  const cr = windows.find((w) => w.id === 'extra_usage');
  assert.equal(cr.pct, 68.05);
  assert.equal(cr.used, 13.61); // 1361 minor units @ dp=2
  assert.equal(cr.cap, 20); // 2000 @ dp=2
  assert.equal(cr.unit, 'USD');
  assert.equal(cr.letter, 'Cr');
  assert.equal(cr.color, '#009E73');
  // 1st of next month, 00:00 UTC (API gives no reset date)
  assert.match(cr.resets_at, /-01T00:00:00\+00:00$|-01T00:00:00Z$/);
});

test('parse: extra_usage omitted when disabled or absent -> 2 windows', () => {
  const off = JSON.stringify({
    five_hour: { utilization: 1, resets_at: '2026-07-23T20:50:00Z' },
    seven_day: { utilization: 2, resets_at: '2026-07-24T14:00:00Z' },
    extra_usage: { is_enabled: false, monthly_limit: 2000, used_credits: 0 },
  });
  assert.equal(parse(off).windows.length, 2);
  const absent = JSON.stringify({
    five_hour: { utilization: 1, resets_at: '2026-07-23T20:50:00Z' },
    seven_day: { utilization: 2, resets_at: '2026-07-24T14:00:00Z' },
  });
  assert.equal(parse(absent).windows.length, 2);
});

test('parse: missing five_hour/seven_day throws auth_expired', () => {
  assert.throws(() => parse('{"unrelated": true}'), AuthExpiredError);
});

test('parse: unparseable body throws auth_expired', () => {
  assert.throws(() => parse('not json'), AuthExpiredError);
});
