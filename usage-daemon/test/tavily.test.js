import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, AuthExpiredError } from '../src/providers/tavily.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, 'fixtures/tavily-account.json');
const raw = readFileSync(FIXTURE, 'utf8');

test('parse: tier from current_plan', () => {
  const { tier } = parse(raw);
  assert.equal(tier, 'free');
});

test('parse: credits window shows remaining, not consumed', () => {
  const { windows } = parse(raw);
  assert.equal(windows.length, 1);
  const w = windows[0];
  assert.equal(w.id, 'credits');
  assert.equal(w.label, 'Credits');
  assert.equal(w.letter, 'Cr');
  assert.equal(w.used, 658); // remaining = limit - usage = 1000 - 342
  assert.equal(w.used_is_remaining, true);
  assert.equal(w.cap, 1000);
  assert.equal(w.unit, 'searches');
  assert.equal(w.color, '#D55E00'); // Okabe-Ito vermillion
  assert.equal(w.resets_at, '2026-08-14T13:25:19.683Z');
  assert.equal(w.will_deplete, false);
});

test('parse: pct is consumed fraction of the plan cap', () => {
  const { windows } = parse(raw);
  assert.ok(Math.abs(windows[0].pct - 34.2) < 1e-9); // 342/1000 * 100
});

test('parse: pct is null when limit is absent', () => {
  const { windows } = parse(JSON.stringify({ usage: 50 }));
  assert.equal(windows[0].pct, null);
  assert.equal(windows[0].cap, null);
  assert.equal(windows[0].used, null); // no limit -> no remaining figure either
});

test('parse: _credits meta with raw figures', () => {
  const { _credits } = parse(raw);
  assert.equal(_credits.usage, 342);
  assert.equal(_credits.limit, 1000);
  assert.equal(_credits.plan, 'free');
  assert.equal(_credits.plan_display_name, 'Free');
  assert.equal(_credits.last_reset, '2026-08-14T13:25:19.683Z');
});

test('parse: auth error on env.error throws AuthExpiredError', () => {
  assert.throws(
    () => parse(JSON.stringify({ error: 'unauthorized' })),
    AuthExpiredError,
  );
});

test('parse: success:false throws AuthExpiredError', () => {
  assert.throws(
    () => parse(JSON.stringify({ success: false })),
    AuthExpiredError,
  );
});

test('parse: no usage figure throws AuthExpiredError', () => {
  assert.throws(() => parse('{}'), AuthExpiredError);
});

test('parse: unparseable JSON throws AuthExpiredError', () => {
  assert.throws(() => parse('not json'), AuthExpiredError);
});
