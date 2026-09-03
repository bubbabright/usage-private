import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, AuthExpiredError } from '../src/providers/openrouter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const keyText = readFileSync(path.resolve(here, 'fixtures/openrouter-key.json'), 'utf8');
const creditsText = readFileSync(path.resolve(here, 'fixtures/openrouter-credits.json'), 'utf8');

// fetch() ships { key, credits } as JSON strings — mirror that in the fixture.
const envelope = JSON.stringify({ key: keyText, credits: creditsText });

test('parse: both windows from key + credits', () => {
  const { windows, tier } = parse(envelope);
  const keyLimit = windows.find((w) => w.id === 'key_limit');
  const credits = windows.find((w) => w.id === 'credits');

  assert.equal(tier, 'paid');

  assert.ok(Math.abs(keyLimit.pct - 58.8) < 1e-9); // 58.8 / 100
  assert.equal(keyLimit.resets_at, null);
  assert.equal(keyLimit.color, '#56B4E9');

  assert.ok(Math.abs(credits.pct - 58.8) < 1e-9); // 58.8 / 100
  assert.equal(credits.resets_at, null);
  assert.equal(credits.color, '#E69F00');
});

test('parse: credits window alone when /key missing (only provisioning key path)', () => {
  const { windows } = parse(JSON.stringify({ key: null, credits: creditsText }));
  assert.equal(windows.length, 1);
  assert.equal(windows[0].id, 'credits');
});

test('parse: key window alone when /credits 401s (normal inference key)', () => {
  const { windows } = parse(JSON.stringify({ key: keyText, credits: null }));
  assert.equal(windows.length, 1);
  assert.equal(windows[0].id, 'key_limit');
});

test('parse: unlimited key (limit null) drops key_limit window', () => {
  const unlimited = JSON.stringify({ data: { usage: 5, limit: null, is_free_tier: true } });
  const { windows, tier } = parse(JSON.stringify({ key: unlimited, credits: creditsText }));
  assert.equal(tier, 'free');
  assert.equal(windows.find((w) => w.id === 'key_limit'), undefined);
  assert.ok(windows.find((w) => w.id === 'credits'));
});

test('parse: pct clamps at 100 when usage exceeds limit', () => {
  const over = JSON.stringify({ data: { usage: 150, limit: 100 } });
  const { windows } = parse(JSON.stringify({ key: over, credits: null }));
  assert.equal(windows.find((w) => w.id === 'key_limit').pct, 100);
});

test('parse: an empty envelope throws, but NOT as an auth failure', () => {
  // Regression: this used to throw AuthExpiredError, which sent a key that had
  // authenticated perfectly well down the "your credentials are bad" path.
  // No meter is a data problem, not a credentials problem.
  assert.throws(
    () => parse(JSON.stringify({ key: null, credits: null })),
    (err) => err instanceof Error && !(err instanceof AuthExpiredError),
  );
});

test('parse: an uncapped key with no purchased credits still reports a balance', () => {
  // The real-world shape that produced "no usable OpenRouter meter": limit is
  // null (uncapped key) and total_credits is 0 (never pre-purchased). There is
  // still a balance worth showing.
  const envelope = JSON.stringify({
    key: JSON.stringify({ data: { limit: null, usage: 0.25, is_free_tier: false } }),
    credits: JSON.stringify({ data: { total_credits: 0, total_usage: 0.25 } }),
  });
  const { windows } = parse(envelope);
  const bal = windows.find((w) => w.id === 'credits');
  assert.ok(bal, 'a balance window is emitted instead of throwing');
  assert.equal(bal.pct, null, 'no cap -> no percentage -> client renders a value, not a bar');
  assert.equal(bal.used, -0.25, 'balance = total_credits - total_usage');
  assert.equal(bal.unit, 'USD');
  assert.equal(bal.used_is_remaining, true);
});

test('parse: a funded account still reports credits as a percentage', () => {
  const envelope = JSON.stringify({
    key: null,
    credits: JSON.stringify({ data: { total_credits: 40, total_usage: 10 } }),
  });
  const { windows } = parse(envelope);
  const bal = windows.find((w) => w.id === 'credits');
  assert.equal(bal.pct, 25);
  assert.equal(bal.used, 10);
  assert.equal(bal.cap, 40);
  assert.equal(bal.unit, 'USD');
});
