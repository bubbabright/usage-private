import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parse,
  AuthExpiredError,
  ROLLING_COLOR,
  WEEKLY_COLOR,
  MONTHLY_COLOR,
  CAPS,
} from '../src/providers/opencode-go.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const goHtml = readFileSync(path.resolve(here, 'fixtures/opencode-go-go.html'), 'utf8');

test('parse: 3 windows from rollingUsage/weeklyUsage/monthlyUsage hydration', () => {
  const { tier, windows, segments } = parse(goHtml);
  assert.equal(tier, 'lite');
  assert.equal(windows.length, 3);
  assert.deepEqual(segments, []);

  const rolling = windows.find((w) => w.id === '5h');
  const weekly = windows.find((w) => w.id === 'weekly');
  const monthly = windows.find((w) => w.id === 'monthly');

  assert.equal(rolling.pct, 6);
  assert.equal(rolling.letter, '5h');
  assert.equal(rolling.color, ROLLING_COLOR);
  assert.equal(rolling.will_deplete, false);

  assert.equal(weekly.pct, 2);
  assert.equal(weekly.letter, 'Wk');
  assert.equal(weekly.color, WEEKLY_COLOR);

  assert.equal(monthly.pct, 1);
  assert.equal(monthly.letter, 'Mo');
  assert.equal(monthly.color, MONTHLY_COLOR);
});

test('parse: resets_at derived from resetInSec relative to now', () => {
  const before = Date.now();
  const { windows } = parse(goHtml);
  const after = Date.now();
  const rolling = windows.find((w) => w.id === '5h');
  const resetMs = new Date(rolling.resets_at).getTime();
  // resetInSec:5507 in the fixture
  assert.ok(resetMs >= before + 5507 * 1000);
  assert.ok(resetMs <= after + 5507 * 1000);
});

test('parse: status!=="ok" window yields null pct', () => {
  const html = goHtml.replace(
    'rollingUsage:$R[33]={status:"ok",resetInSec:5507,usagePercent:6}',
    'rollingUsage:$R[33]={status:"error",resetInSec:5507,usagePercent:6}',
  );
  const { windows } = parse(html);
  assert.equal(windows.find((w) => w.id === '5h').pct, null);
});

test('parse: missing rollingUsage block throws auth_expired', () => {
  assert.throws(() => parse('<html><body>logged out</body></html>'), AuthExpiredError);
});

test('parse: localCosts override ONLY the 5h window; weekly/monthly stay scraped', () => {
  // opencode.ai's scraped weekly/monthly are authoritative (their billing).
  // The local trailing-window sums diverge from it, so only 5h — where the
  // scraped page lags — is recomputed from local $ ÷ cap.
  const envelope = JSON.stringify({
    html: goHtml,
    localCosts: { '5h': 1.2, weekly: 3, monthly: 30 },
    localSegments: null,
  });
  const { windows } = parse(envelope);
  // 5h: local override (1.2 / 12 = 10%)
  assert.equal(windows.find((w) => w.id === '5h').pct, (100 * 1.2) / CAPS['5h']);
  // weekly/monthly: unchanged from the scraped fixture (2% / 1%), NOT local.
  assert.equal(windows.find((w) => w.id === 'weekly').pct, 2);
  assert.equal(windows.find((w) => w.id === 'monthly').pct, 1);
});

test('parse: local cost of 0 does not clobber a correctly-high scraped pct (max, not override)', () => {
  // Real incident 2026-08-17: local db had one $0 message in the trailing 5h
  // (usage happened on another device) while opencode.ai's scraped page
  // correctly read ~100%. Local should never pull the reported pct DOWN.
  const html = `
    <script>
      $R.push(["lite.subscription.get", ["wrk_x"], {
        rollingUsage: { status: "ok", resetInSec: 1860, usagePercent: 100 },
        weeklyUsage: { status: "ok", resetInSec: 200, usagePercent: 10 },
        monthlyUsage: { status: "ok", resetInSec: 300, usagePercent: 5 },
      }]);
    </script>
  `;
  const envelope = JSON.stringify({
    html,
    localCosts: { '5h': 0, weekly: 0, monthly: 0 },
    localSegments: null,
  });
  const { windows } = parse(envelope);
  assert.equal(windows.find((w) => w.id === '5h').pct, 100);
});

test('parse: status "rate-limited" is trusted like "ok" (window exhausted, not an error)', () => {
  // Real incident 2026-08-17: opencode.ai reports rollingUsage status
  // "rate-limited" (not "ok") once the 5h window is fully used, still with
  // a valid usagePercent. Previously this was treated the same as "error"
  // (null), and with no/zero local cost that showed as 0% instead of 100%.
  const html = `
    <script>
      $R.push(["lite.subscription.get", ["wrk_x"], {
        rollingUsage: { status: "rate-limited", resetInSec: 845, usagePercent: 100 },
        weeklyUsage: { status: "ok", resetInSec: 200, usagePercent: 40 },
        monthlyUsage: { status: "ok", resetInSec: 300, usagePercent: 20 },
      }]);
    </script>
  `;
  const envelope = JSON.stringify({ html, localCosts: { '5h': 0, weekly: 0, monthly: 0 }, localSegments: null });
  const { windows } = parse(envelope);
  assert.equal(windows.find((w) => w.id === '5h').pct, 100);
});

test('parse: envelope with localCosts null falls back to scraped pct (matches bare-HTML path)', () => {
  const envelope = JSON.stringify({ html: goHtml, localCosts: null, localSegments: null });
  const bare = parse(goHtml);
  const wrapped = parse(envelope);
  const pctsOf = (r) => r.windows.map((w) => ({ id: w.id, pct: w.pct }));
  assert.deepEqual(pctsOf(wrapped), pctsOf(bare));
});

test('parse: envelope localSegments become per-model segments', () => {
  const envelope = JSON.stringify({
    html: goHtml,
    localCosts: null,
    localSegments: [
      { model: 'deepseek-v4-flash', cost: 0.1 },
      { model: 'qwen3.7-plus', cost: 0.05 },
    ],
  });
  const { segments } = parse(envelope);
  assert.deepEqual(segments, [
    { model: 'deepseek-v4-flash', cost: 0.1 },
    { model: 'qwen3.7-plus', cost: 0.05 },
  ]);
});

test('parse: pct clamped to 100 when local cost exceeds cap', () => {
  const envelope = JSON.stringify({ html: goHtml, localCosts: { '5h': 999, weekly: null, monthly: null } });
  const { windows } = parse(envelope);
  assert.equal(windows.find((w) => w.id === '5h').pct, 100);
});

test('parse: field order in the object literal does not matter', () => {
  const html = `
    <script>
      $R.push(["lite.subscription.get", ["wrk_x"], {
        rollingUsage: { usagePercent: 42, status: "ok", resetInSec: 100 },
        weeklyUsage: { status: "ok", resetInSec: 200, usagePercent: 10 },
        monthlyUsage: { resetInSec: 300, usagePercent: 5, status: "ok" },
      }]);
    </script>
  `;
  const { windows } = parse(html);
  assert.equal(windows.find((w) => w.id === '5h').pct, 42);
  assert.equal(windows.find((w) => w.id === 'weekly').pct, 10);
  assert.equal(windows.find((w) => w.id === 'monthly').pct, 5);
});
