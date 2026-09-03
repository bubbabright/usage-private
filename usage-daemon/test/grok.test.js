import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, parseGrokCreditsConfig, AuthExpiredError } from '../src/providers/grok.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Combined envelope: scrubbed monthly billing JSON + base64 gRPC-web weekly frame.
const FIXTURE = path.resolve(here, 'fixtures/grok-usage.json');
const raw = readFileSync(FIXTURE, 'utf8');

test('parse: monthly (Mo) + weekly (Wk) windows with correct pct/resets/letter/color', () => {
  const { windows } = parse(raw);
  const monthly = windows.find((w) => w.id === 'monthly');
  const weekly = windows.find((w) => w.id === 'weekly');

  // monthly: used 1234 / limit 10000 (cents) -> 12.34%
  assert.equal(monthly.pct, 12.34);
  assert.equal(monthly.resets_at, '2026-08-01T00:00:00Z');
  assert.equal(monthly.letter, 'Mo');
  assert.equal(monthly.color, '#56B4E9');

  // weekly: fixed32 credit_usage_percent = 42.5, reset unix 2_000_000_000
  assert.equal(weekly.pct, 42.5);
  assert.equal(weekly.resets_at, new Date(2_000_000_000 * 1000).toISOString());
  assert.equal(weekly.letter, 'Wk');
  assert.equal(weekly.color, '#E69F00');
});

test('parse: grok inverts claude colors (monthly blue, weekly orange)', () => {
  const { windows } = parse(raw);
  assert.equal(windows.find((w) => w.id === 'monthly').color, '#56B4E9');
  assert.equal(windows.find((w) => w.id === 'weekly').color, '#E69F00');
});

test('parse: tier is null and no segments (grok has neither)', () => {
  const { tier, segments } = parse(raw);
  assert.equal(tier, null);
  assert.deepEqual(segments, []);
});

test('parse: {val:x}-wrapped and .config-nested billing both unwrap', () => {
  // bare scalars, no .config nesting -> same result path
  const flat = JSON.stringify({
    billing: JSON.stringify({ used: 500, monthlyLimit: 10000, billingPeriodEnd: 'X' }),
    credits: null,
  });
  const { windows } = parse(flat);
  assert.equal(windows.find((w) => w.id === 'monthly').pct, 5);
});

test('parse: weekly is best-effort — null/garbage credits yield weekly pct null, monthly intact', () => {
  const noCredits = JSON.stringify({
    billing: JSON.stringify({ config: { used: 1000, monthlyLimit: 10000, billingPeriodEnd: 'X' } }),
    credits: null,
  });
  const { windows } = parse(noCredits);
  assert.equal(windows.find((w) => w.id === 'monthly').pct, 10);
  const weekly = windows.find((w) => w.id === 'weekly');
  assert.equal(weekly.pct, null);
  assert.equal(weekly.resets_at, null);

  // unparseable credits (not a protobuf frame) also degrades gracefully
  const badCredits = JSON.stringify({
    billing: JSON.stringify({ config: { used: 1000, monthlyLimit: 10000 } }),
    credits: Buffer.from([0xff, 0xff, 0xff]).toString('base64'),
  });
  assert.equal(parse(badCredits).windows.find((w) => w.id === 'weekly').pct, null);
});

test('parse: missing used/monthlyLimit throws auth_expired', () => {
  const bad = JSON.stringify({ billing: JSON.stringify({ config: { foo: 1 } }), credits: null });
  assert.throws(() => parse(bad), AuthExpiredError);
});

test('parse: limit === 0 is a real "no monthly cap" plan state, not auth_expired — pct null, no divide-by-zero', () => {
  const zero = JSON.stringify({
    billing: JSON.stringify({ used: 5, monthlyLimit: 0 }),
    credits: null,
  });
  const { windows } = parse(zero);
  const monthly = windows.find((w) => w.id === 'monthly');
  assert.ok(monthly);
  assert.equal(monthly.pct, null);
});

test('parse: unparseable billing / envelope throws auth_expired', () => {
  assert.throws(() => parse('not json'), AuthExpiredError);
  assert.throws(() => parse(JSON.stringify({ billing: 'not json', credits: null })), AuthExpiredError);
});

// --- weekly protobuf scanner edge cases (parseGrokCreditsConfig) ---

function varint(n) {
  const out = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return out;
}
function frame(payload) {
  const len = payload.length;
  return new Uint8Array([
    0x00, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff,
    ...payload,
  ]);
}

test('parseGrokCreditsConfig: proto3-zero — usage period present, no % float -> 0%', () => {
  // field1 msg { field6: varint=1 (usage period), field5 msg { field1: varint ts } }
  const innerInner = [0x08, ...varint(2_000_000_000)];      // [1,5,1] reset
  const inner = [
    0x30, 0x01,                                             // field6 varint=1 -> [1,6]
    0x2a, innerInner.length, ...innerInner,                 // field5 msg
  ];
  const msg = [0x0a, inner.length, ...inner];
  const parsed = parseGrokCreditsConfig(frame(msg));
  assert.equal(parsed.usedPercent, 0);
  assert.equal(parsed.resetsAtMs, 2_000_000_000 * 1000);
});

test('parseGrokCreditsConfig: empty/garbage bytes -> null', () => {
  assert.equal(parseGrokCreditsConfig(new Uint8Array([])), null);
  assert.equal(parseGrokCreditsConfig(null), null);
});
