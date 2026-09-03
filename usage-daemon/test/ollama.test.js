import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, AuthExpiredError } from '../src/providers/ollama.js';
import { slope, willDeplete } from '../src/burnrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Vendored + PII-scrubbed capture of ollama.com/settings (Usage tab). The usage
// markup (tier pill, aria-labels, data-time resets) is byte-preserved; only the
// account handle/email were replaced with placeholders.
const FIXTURE = path.resolve(here, 'fixtures/ollama-settings.html');
const html = readFileSync(FIXTURE, 'utf8');

test('parse: tier from the capitalize pill (whitespace-tolerant)', () => {
  const { tier } = parse(html);
  assert.equal(tier, 'free');
});

test('parse: session + weekly windows at 0% with correct resets', () => {
  const { windows } = parse(html);
  const session = windows.find((w) => w.id === 'session');
  const weekly = windows.find((w) => w.id === 'weekly');

  assert.equal(session.pct, 0);
  assert.equal(session.resets_at, '2026-07-11T10:00:00Z');
  assert.equal(session.color, '#E69F00');

  assert.equal(weekly.pct, 0);
  assert.equal(weekly.resets_at, '2026-07-13T00:00:00Z');
  assert.equal(weekly.color, '#56B4E9');
});

test('parse: no segments at 0% usage', () => {
  const { segments } = parse(html);
  assert.deepEqual(segments, []);
});

test('parse: decimal pct (real pages report e.g. 0.4%)', () => {
  const snippet = `
    <div>Cloud usage <span class="capitalize">free</span></div>
    <div aria-label="Session usage 0% used" data-time="2026-07-12T01:00:00Z"></div>
    <div aria-label="Weekly usage 0.4% used" data-time="2026-07-13T00:00:00Z"></div>`;
  const { windows } = parse(snippet);
  assert.equal(windows.find((w) => w.id === 'session').pct, 0);
  assert.equal(windows.find((w) => w.id === 'weekly').pct, 0.4);
});

test('parse: segments parse when usage > 0', () => {
  const snippet = `Cloud usage <span class="capitalize">free</span>
    <div data-usage-segment data-model="nemotron-3-nano:30b" data-requests="9"></div>`;
  const { segments } = parse(snippet);
  assert.deepEqual(segments, [{ model: 'nemotron-3-nano:30b', requests: 9 }]);
});

test('parse: logged-out page throws auth_expired', () => {
  assert.throws(() => parse('<html><body>please sign in</body></html>'), AuthExpiredError);
});

test('burnrate: slope of a clean line', () => {
  assert.equal(slope([[0, 0], [1, 2], [2, 4]]), 2);
});

test('burnrate: willDeplete true when projected past 100 before reset', () => {
  const now = 1_000_000;
  const reset = new Date(now + 10_000).toISOString();
  // climbing 5%/1000ms from 50 -> in 10s adds 50 -> reaches 100 by reset
  const history = [
    { t: now - 4000, session: 30 },
    { t: now - 3000, session: 35 },
    { t: now - 2000, session: 40 },
    { t: now - 1000, session: 45 },
    { t: now, session: 50 },
  ];
  assert.equal(willDeplete(history, 'session', 50, reset, now), true);
});

test('burnrate: willDeplete false when flat', () => {
  const now = 1_000_000;
  const reset = new Date(now + 10_000).toISOString();
  const history = [
    { t: now - 2000, session: 20 },
    { t: now - 1000, session: 20 },
    { t: now, session: 20 },
  ];
  assert.equal(willDeplete(history, 'session', 20, reset, now), false);
});
