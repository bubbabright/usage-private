import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parse,
  AuthExpiredError,
  RateLimitedError,
  FREE_NEURONS_PER_DAY,
  nextUtcMidnight,
} from '../src/providers/cloudflare.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Real capture of aiInferenceAdaptiveGroups for one UTC day (2026-07-18), only
// the account tag scrubbed. 7 per-model rows summing to 4983.683301 neurons.
const REAL = readFileSync(path.resolve(here, 'fixtures/cloudflare-ai-day.json'), 'utf8');

test('parse: sums totalNeurons across models into daily pct', () => {
  const { windows, segments } = parse(REAL);
  const w = windows.find((x) => x.id === 'daily_neurons');

  const expectedPct = (100 * 4983.683301429079) / FREE_NEURONS_PER_DAY;
  assert.ok(Math.abs(w.pct - expectedPct) < 1e-6);
  assert.equal(w.color, '#E69F00');
  assert.equal(w.resets_at, nextUtcMidnight());

  // per-model segments, largest first
  assert.equal(segments.length, 7);
  assert.ok(segments[0].neurons >= segments[segments.length - 1].neurons);
  assert.ok(segments[0].model.startsWith('@cf/'));
});

test('parse: empty groups = 0% today (valid, not an error)', () => {
  const empty = JSON.stringify({
    data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [] }] } },
    errors: null,
  });
  const { windows } = parse(empty);
  assert.equal(windows[0].pct, 0);
});

test('parse: overage past the free allocation is NOT clamped', () => {
  const over = JSON.stringify({
    data: {
      viewer: {
        accounts: [
          {
            aiInferenceAdaptiveGroups: [
              { sum: { totalNeurons: 15000 }, dimensions: { date: '2026-07-23', modelId: '@cf/x' } },
            ],
          },
        ],
      },
    },
  });
  assert.equal(parse(over).windows[0].pct, 150);
});

test('parse: graphql auth error -> auth_expired', () => {
  const err = JSON.stringify({
    data: null,
    errors: [{ message: 'Authentication error', extensions: { code: 'authz' } }],
  });
  assert.throws(() => parse(err), AuthExpiredError);
});

test('parse: graphql quota error -> rate_limited', () => {
  const err = JSON.stringify({
    data: null,
    errors: [{ message: 'time range too wide', extensions: { code: 'quota' } }],
  });
  assert.throws(() => parse(err), RateLimitedError);
});

test('parse: no account matched -> auth_expired', () => {
  const none = JSON.stringify({ data: { viewer: { accounts: [] } } });
  assert.throws(() => parse(none), AuthExpiredError);
});
