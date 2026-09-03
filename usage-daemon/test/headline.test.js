import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHeadline } from '../src/headline.js';

const NOW = Date.UTC(2026, 6, 20, 12, 0, 0); // 2026-07-20T12:00:00Z

function row(hoursAgo, fields) {
  return { t: NOW - hoursAgo * 3600 * 1000, ...fields };
}

test('poll scope: picks the window with the largest delta vs the second-to-last row', () => {
  const providersData = [
    {
      name: 'claude',
      label: 'Claude',
      current: { windows: [{ id: 'session', pct: 12, label: '5h', color: '#E69F00' }] },
      history: [row(1, { session: 10 }), row(0.1, { session: 11 })], // delta = 12-11 = 1
    },
    {
      name: 'mistral',
      label: 'Mistral',
      current: { windows: [{ id: 'vibe_monthly', pct: 100, label: 'Vibe', color: '#E69F00' }] },
      history: [row(1, { vibe_monthly: 40 }), row(0.1, { vibe_monthly: 40 })], // delta = 100-40 = 60
    },
  ];
  const { poll } = computeHeadline(providersData, NOW);
  assert.equal(poll.provider, 'mistral');
  assert.equal(poll.delta, 60);
  assert.equal(poll.from_pct, 40);
  assert.equal(poll.to_pct, 100);
});

test('24h scope: finds the last history row at or before now-24h', () => {
  const providersData = [
    {
      name: 'claude',
      label: 'Claude',
      current: { windows: [{ id: 'weekly', pct: 63, label: '7d', color: '#56B4E9' }] },
      history: [
        row(30, { weekly: 20 }),
        row(25, { weekly: 25 }), // last row at/before now-24h -> from_pct = 25
        row(10, { weekly: 50 }),
        row(0.1, { weekly: 62 }),
      ],
    },
  ];
  const { '24h': h24 } = computeHeadline(providersData, NOW);
  assert.equal(h24.from_pct, 25);
  assert.equal(h24.delta, 38);
});

test('provider/window with no history at that scope is skipped, not crashed on', () => {
  const providersData = [
    {
      name: 'fresh',
      label: 'Fresh',
      current: { windows: [{ id: 'x', pct: 5, label: 'X', color: null }] },
      history: [row(0.1, { x: 5 })], // only 1 row -> no 24h-ago point exists
    },
  ];
  const { '24h': h24, poll } = computeHeadline(providersData, NOW);
  assert.equal(h24, null);
  assert.equal(poll, null); // also < 2 rows, no poll-delta either
});

test('zero delta does not win (nothing moved)', () => {
  const providersData = [
    {
      name: 'flat',
      label: 'Flat',
      current: { windows: [{ id: 'x', pct: 5, label: 'X', color: null }] },
      history: [row(1, { x: 5 }), row(0.1, { x: 5 })],
    },
  ];
  const { poll } = computeHeadline(providersData, NOW);
  assert.equal(poll, null);
});

test('depleting: picks the short window with the soonest projected ETA', () => {
  const providersData = [
    {
      name: 'claude',
      label: 'Claude',
      current: {
        windows: [
          { id: 'session', label: '5h', pct: 80, will_deplete: true, resets_at: '2026-07-21T00:00:00Z' },
        ],
      },
      // rising ~10pt/hr -> hits 100 in ~2h
      history: [row(2, { session: 60 }), row(1, { session: 70 }), row(0.1, { session: 80 })],
    },
    {
      name: 'opencode-go',
      label: 'OpenCode Go',
      current: {
        windows: [
          { id: '5h', label: '5 Hour', pct: 90, will_deplete: true, resets_at: '2026-07-21T00:00:00Z' },
        ],
      },
      // rising ~20pt/hr -> hits 100 in ~0.5h, sooner than claude's ~2h
      history: [row(2, { '5h': 50 }), row(1, { '5h': 70 }), row(0.1, { '5h': 90 })],
    },
  ];
  const { depleting } = computeHeadline(providersData, NOW);
  assert.equal(depleting.provider, 'opencode-go');
});

test('depleting: weekly/monthly windows are excluded even if will_deplete is true', () => {
  const providersData = [
    {
      name: 'claude',
      label: 'Claude',
      current: {
        windows: [
          { id: 'weekly', label: '7d', pct: 95, will_deplete: true, resets_at: '2026-07-25T00:00:00Z' },
        ],
      },
      history: [row(2, { weekly: 50 }), row(1, { weekly: 80 }), row(0.1, { weekly: 95 })],
    },
  ];
  const { depleting } = computeHeadline(providersData, NOW);
  assert.equal(depleting, null);
});

test('depleting: will_deplete false is ignored even with a rising short window', () => {
  const providersData = [
    {
      name: 'claude',
      label: 'Claude',
      current: {
        windows: [{ id: 'session', label: '5h', pct: 30, will_deplete: false, resets_at: '2026-07-25T00:00:00Z' }],
      },
      history: [row(2, { session: 10 }), row(1, { session: 20 }), row(0.1, { session: 30 })],
    },
  ];
  const { depleting } = computeHeadline(providersData, NOW);
  assert.equal(depleting, null);
});

test('all scopes null when no providers have usable history', () => {
  const { poll, '12h': h12, '24h': h24 } = computeHeadline([], NOW);
  assert.equal(poll, null);
  assert.equal(h12, null);
  assert.equal(h24, null);
});

test('pct === null windows are ignored', () => {
  const providersData = [
    {
      name: 'p',
      label: 'P',
      current: { windows: [{ id: 'x', pct: null, label: 'X', color: null }] },
      history: [row(1, { x: 5 }), row(0.1, { x: 10 })],
    },
  ];
  const { poll } = computeHeadline(providersData, NOW);
  assert.equal(poll, null);
});
