import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, AuthExpiredError } from '../src/providers/cohere.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, 'fixtures/cohere-usage.json');
const raw = readFileSync(FIXTURE, 'utf8');

test('parse: tokens window sums input+output across products, no cap', () => {
  const { windows } = parse(raw);
  assert.equal(windows.length, 1);
  const w = windows[0];
  assert.equal(w.id, 'tokens');
  assert.equal(w.label, 'Tokens (30d)');
  assert.equal(w.letter, 'Tk');
  assert.equal(w.used, 16973); // (36+4692+36) input + (9+12189+11) output
  assert.equal(w.cap, null);
  assert.equal(w.pct, null);
  assert.equal(w.resets_at, null);
  assert.equal(w.color, '#D55E00');
});

test('parse: _cohere meta with raw figures', () => {
  const { _cohere } = parse(raw);
  assert.equal(_cohere.input_tokens, 4764);
  assert.equal(_cohere.output_tokens, 12209);
  assert.equal(_cohere.total_tokens, 16973);
});

test('parse: empty usages array gives zero tokens, not an error', () => {
  const { windows } = parse(JSON.stringify({ usages: [] }));
  assert.equal(windows[0].used, 0);
});

test('parse: missing usages array throws AuthExpiredError', () => {
  assert.throws(() => parse(JSON.stringify({})), AuthExpiredError);
});

test('parse: unparseable JSON throws AuthExpiredError', () => {
  assert.throws(() => parse('not json'), AuthExpiredError);
});
