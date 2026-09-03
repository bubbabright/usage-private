import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parse,
  extractSpendTotal,
  nextMonthStartUtc,
  vibeIntervalSeconds,
  AuthExpiredError,
  VIBE_COLOR,
  API_COLOR,
  SPEND_COLOR,
} from '../src/providers/mistral.js';

// Build a billing.budget tRPC envelope (the current vibe/api meter shape).
function budgetEnvelope({
  vibePct = 0,
  apiPct = null,
  paygEnabled = false,
  resetAt = '2026-09-01T00:00:00Z',
} = {}) {
  const leg = (usage_percentage) => ({
    usage_percentage,
    initial_budget: 10,
    currency: 'USD',
    reset_at: resetAt,
    payg_enabled: paygEnabled,
  });
  const json = { vibe_budget: leg(vibePct) };
  if (apiPct !== null) json.api_budget = leg(apiPct);
  return JSON.stringify({ result: { data: { json } } });
}

const here = path.dirname(fileURLToPath(import.meta.url));
const vibeRaw = readFileSync(path.resolve(here, 'fixtures/mistral-vibe.json'), 'utf8');
const usageRaw = readFileSync(path.resolve(here, 'fixtures/mistral-usage.json'), 'utf8');
const limitRaw = readFileSync(
  path.resolve(here, 'fixtures/mistral-spend-limit.json'),
  'utf8',
);

function envelope({ vibe = null, usage = null, spend_limit = null } = {}) {
  return JSON.stringify({ vibe, usage, spend_limit });
}

test('parse vibe: ready-made percentage passthrough, no dollar fields', () => {
  // fixture = 0% vibe, 0% api
  const { windows, tier, _vibe } = parse(envelope({ vibe: vibeRaw }));
  const w = windows.find((x) => x.id === 'vibe_monthly');
  assert.ok(w);
  assert.equal(w.pct, 0);
  assert.equal(w.used, undefined);
  assert.equal(w.cap, undefined);
  assert.equal(w.unit, undefined);
  assert.equal(w.resets_at, '2026-09-01T00:00:00Z'); // literal passthrough from fixture
  assert.equal(w.letter, 'Vb');
  assert.equal(w.label, 'Vibe');
  assert.equal(w.color, VIBE_COLOR);
  assert.equal(w.will_deplete, false);
  assert.equal(tier, 'free');
  assert.deepEqual(_vibe, { pct: 0, resetAt: '2026-09-01T00:00:00Z' });
});

test('parse api_monthly: bonus window from same call, no admin key needed', () => {
  const { windows } = parse(envelope({ vibe: vibeRaw }));
  const w = windows.find((x) => x.id === 'api_monthly');
  assert.ok(w);
  assert.equal(w.pct, 0);
  assert.equal(w.letter, 'Ap');
  assert.equal(w.label, 'API');
  assert.equal(w.color, API_COLOR);
  assert.equal(windows.length, 2); // vibe_monthly + api_monthly, no admin legs
});

test('parse vibe: mid-value percentage passthrough', () => {
  const { windows } = parse(envelope({ vibe: budgetEnvelope({ vibePct: 55 }) }));
  const w = windows.find((x) => x.id === 'vibe_monthly');
  assert.equal(w.pct, 55);
});

test('parse vibe: usagePercentage clamped 0-100', () => {
  const over = parse(envelope({ vibe: budgetEnvelope({ vibePct: 150 }) }));
  assert.equal(over.windows.find((w) => w.id === 'vibe_monthly').pct, 100);
  const under = parse(envelope({ vibe: budgetEnvelope({ vibePct: -5 }) }));
  assert.equal(under.windows.find((w) => w.id === 'vibe_monthly').pct, 0);
});

test('parse vibe: payg_enabled → tier null, pct still passed through', () => {
  // Unverified against a live PAYG account — pinning unconditional passthrough.
  const { windows, tier } = parse(
    envelope({ vibe: budgetEnvelope({ vibePct: 40, paygEnabled: true }) }),
  );
  assert.equal(windows.find((w) => w.id === 'vibe_monthly').pct, 40);
  assert.equal(tier, null);
});

test('parse vibe: malformed/missing reset_at falls back to nextMonthStartUtc()', () => {
  const malformed = parse(
    envelope({ vibe: budgetEnvelope({ vibePct: 10, resetAt: 'not-a-date' }) }),
  );
  assert.equal(
    malformed.windows.find((w) => w.id === 'vibe_monthly').resets_at,
    nextMonthStartUtc(),
  );
});

test('parse dual envelope: vibe + api + spend → three windows', () => {
  const { windows } = parse(
    envelope({ vibe: vibeRaw, usage: usageRaw, spend_limit: limitRaw }),
  );
  assert.equal(windows.length, 3);
  const vibe = windows.find((w) => w.id === 'vibe_monthly');
  const spend = windows.find((w) => w.id === 'monthly_spend');
  assert.equal(vibe.pct, 0); // fixture 0%
  assert.equal(spend.pct, 0); // $0 / $10
  assert.equal(spend.letter, '$');
  assert.equal(spend.color, SPEND_COLOR);
  // month=7 year=2026 → 1 Aug UTC
  assert.equal(spend.resets_at, '2026-08-01T00:00:00Z');
});

test('parse vibe-only: two windows (vibe + api), no throw when admin legs null', () => {
  const { windows } = parse(envelope({ vibe: vibeRaw }));
  assert.equal(windows.length, 2);
  assert.ok(windows.some((w) => w.id === 'vibe_monthly'));
  assert.ok(windows.some((w) => w.id === 'api_monthly'));
});

test('parse spend with no_monthly_limit: pct null, window still present', () => {
  const unlimited = JSON.stringify({ amount: 0, no_monthly_limit: true });
  const usage = JSON.stringify({ total: 3.5, month: 7, year: 2026 });
  // spend-only path (no vibe)
  const { windows } = parse(
    envelope({ vibe: null, usage, spend_limit: unlimited }),
  );
  const spend = windows.find((w) => w.id === 'monthly_spend');
  assert.ok(spend);
  assert.equal(spend.pct, null);
  assert.equal(spend.resets_at, '2026-08-01T00:00:00Z');
});

test('parse spend: non-zero spend / cap pct', () => {
  const usage = JSON.stringify({ total: 2.5 });
  const limit = JSON.stringify({ amount: 10, no_monthly_limit: false });
  const { windows } = parse(
    envelope({ vibe: null, usage, spend_limit: limit }),
  );
  assert.equal(windows.find((w) => w.id === 'monthly_spend').pct, 25);
});

test('parse: garbage vibe alone throws auth_expired', () => {
  assert.throws(
    () => parse(envelope({ vibe: '{"unrelated":true}' })),
    AuthExpiredError,
  );
  assert.throws(() => parse(envelope({ vibe: 'not json' })), AuthExpiredError);
  assert.throws(() => parse(envelope({})), AuthExpiredError);
  assert.throws(() => parse('not json'), AuthExpiredError);
});

test('parse: spend alone without vibe still ok', () => {
  const { windows } = parse(
    envelope({
      vibe: null,
      usage: usageRaw,
      spend_limit: limitRaw,
    }),
  );
  assert.equal(windows.length, 1);
  assert.equal(windows[0].id, 'monthly_spend');
});

test('extractSpendTotal: total field and category sum', () => {
  assert.equal(extractSpendTotal({ total: 4.2 }), 4.2);
  assert.equal(
    extractSpendTotal({ completion: 1, ocr: 2, audio: 0.5 }),
    3.5,
  );
  assert.equal(extractSpendTotal({}), null);
});

test('nextMonthStartUtc: first of following month', () => {
  const d = new Date(Date.UTC(2026, 6, 15)); // Jul 15 2026
  assert.equal(nextMonthStartUtc(d), '2026-08-01T00:00:00Z');
});

test('vibeIntervalSeconds: default 300s when not maxed', () => {
  assert.equal(vibeIntervalSeconds(99, '2026-09-01T00:00:00Z'), 300);
  assert.equal(vibeIntervalSeconds(null, '2026-09-01T00:00:00Z'), 300); // cold start
});

test('vibeIntervalSeconds: maxed, capped at 24h even with weeks left', () => {
  const now = new Date('2026-08-16T00:00:00Z');
  const resetAt = '2026-09-01T00:00:00Z'; // ~16 days out
  assert.equal(vibeIntervalSeconds(100, resetAt, now), 24 * 3600);
});

test('vibeIntervalSeconds: maxed, reset sooner than cap → seconds until reset', () => {
  const now = new Date('2026-08-31T20:00:00Z');
  const resetAt = '2026-09-01T00:00:00Z'; // 4h out
  assert.equal(vibeIntervalSeconds(100, resetAt, now), 4 * 3600);
});

test('vibeIntervalSeconds: maxed, resetAt in the past → 300s (repoll promptly)', () => {
  const now = new Date('2026-09-02T00:00:00Z');
  assert.equal(vibeIntervalSeconds(100, '2026-09-01T00:00:00Z', now), 300);
});

test('vibeIntervalSeconds: maxed, unparseable resetAt → 300s', () => {
  assert.equal(vibeIntervalSeconds(100, 'not-a-date', new Date()), 300);
});
