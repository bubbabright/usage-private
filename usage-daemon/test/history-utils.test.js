import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findValueAtOrBefore, findActivityBase } from '../src/history-utils.js';

const T = (mins) => mins * 60 * 1000; // minutes -> ms, relative helper for readable fixtures

test('findValueAtOrBefore: picks the latest row at or before the target', () => {
  const history = [
    { t: 0, w: 10 },
    { t: T(10), w: 20 },
    { t: T(20), w: 30 },
  ];
  assert.equal(findValueAtOrBefore(history, 'w', T(15)), 20);
  assert.equal(findValueAtOrBefore(history, 'w', T(20)), 30);
  assert.equal(findValueAtOrBefore(history, 'w', -1), null); // before all history
});

test('findValueAtOrBefore: empty/missing history -> null', () => {
  assert.equal(findValueAtOrBefore([], 'w', 100), null);
  assert.equal(findValueAtOrBefore(null, 'w', 100), null);
});

test('findActivityBase: no reset in window -> same as a plain cutoff lookup', () => {
  // now=70min, window=60min -> cutoff=10min. Latest row at-or-before cutoff is t=8 (w=18).
  const now = T(70);
  const history = [
    { t: T(0), w: 10 },
    { t: T(8), w: 18 }, // at-or-before cutoff (10min) -> this is the candidate
    { t: T(40), w: 40 },
    { t: T(65), w: 65 },
  ];
  const base = findActivityBase(history, 'w', now, T(60));
  assert.equal(base.value, 18);
  assert.equal(base.t, now - T(60));
});

test('findActivityBase: reset within the window -> base is the post-reset value/time, not the stale pre-reset one', () => {
  // now = 70min. Window = last 60min (cutoff = 10min). A reset (80 -> 0) happens at 45min,
  // well inside the window. "Last hour, or since reset, whichever is shorter" means the
  // comparison should start at the reset (0 @ 45min), not at whatever was true at 10min.
  const now = T(70);
  const history = [
    { t: T(0), w: 60 },
    { t: T(20), w: 70 },  // pre-cutoff candidate, but should be overridden by the reset
    { t: T(40), w: 80 },
    { t: T(45), w: 0 },   // reset: dropped from 80 -> 0
    { t: T(55), w: 5 },
    { t: T(65), w: 15 },
  ];
  const base = findActivityBase(history, 'w', now, T(60));
  assert.equal(base.value, 0);
  assert.equal(base.t, T(45));
});

test('findActivityBase: reset BEFORE the window (older than the cutoff) is ignored — normal cutoff lookup applies', () => {
  const now = T(100);
  const history = [
    { t: T(0), w: 80 },
    { t: T(10), w: 0 },  // reset, but this is before cutoff (now-60=T(40)) -> not "within the window"
    { t: T(30), w: 20 },
    { t: T(50), w: 40 }, // this is the at-or-before-cutoff candidate (t <= T(40)? no, 50>40)
    { t: T(60), w: 55 },
  ];
  // cutoff = T(40); latest row at-or-before cutoff is t=T(30), w=20 (t=T(50) is AFTER cutoff)
  const base = findActivityBase(history, 'w', now, T(60));
  assert.equal(base.value, 20);
  assert.equal(base.t, T(40));
});

test('findActivityBase: multiple resets within the window -> uses the MOST RECENT one', () => {
  const now = T(70);
  const history = [
    { t: T(0), w: 50 },
    { t: T(15), w: 0 },  // first reset within window
    { t: T(30), w: 90 },
    { t: T(35), w: 0 },  // second, more recent reset
    { t: T(50), w: 20 },
  ];
  const base = findActivityBase(history, 'w', now, T(60));
  assert.equal(base.value, 0);
  assert.equal(base.t, T(35));
});

test('findActivityBase: no history at all -> null', () => {
  assert.equal(findActivityBase([], 'w', T(70), T(60)), null);
  assert.equal(findActivityBase(null, 'w', T(70), T(60)), null);
});

test('findActivityBase: only a stale pre-cutoff row exists -> falls back to it, same as findValueAtOrBefore', () => {
  const now = T(200);
  const history = [{ t: T(0), w: 10 }]; // long before cutoff (T(140)), no reset in the window
  const base = findActivityBase(history, 'w', now, T(60));
  assert.equal(base.value, 10);
  assert.equal(base.t, now - T(60));
});
