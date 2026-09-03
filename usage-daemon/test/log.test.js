// Logger tests. The point of log.js is that a line is on disk when the process
// dies, so the things worth asserting are: it writes, it timestamps, it rotates
// instead of growing forever, and a broken path degrades instead of throwing
// (a logger that can crash the daemon defeats its own purpose).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'usage-daemon-log-'));
const logPath = path.join(tmp, 'daemon.log');

// Env is read at module load, so it must be set before the import.
process.env.USAGE_LOG_FILE = logPath;
process.env.USAGE_LOG_STDERR = '0'; // keep the test output clean
process.env.USAGE_LOG_LEVEL = 'debug';

const { log, configure, logFile } = await import('../src/log.js');

// Env vars intentionally OUTRANK configure() at runtime (the escape hatch when
// config.toml itself is what's broken). Drop them now that the module has read
// them, so the configure() paths below are actually exercised.
delete process.env.USAGE_LOG_FILE;
delete process.env.USAGE_LOG_LEVEL;

test('log: writes a timestamped, level-tagged line to the configured file', () => {
  log.info('hello');
  const text = readFileSync(logPath, 'utf8');
  assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} INFO  usage-daemon: hello/m);
});

test('log: renders context as greppable key=value pairs', () => {
  log.warn('poll failed', { provider: 'grok', consecutive_failures: 3 });
  const text = readFileSync(logPath, 'utf8');
  assert.match(text, /poll failed provider=grok consecutive_failures=3/);
});

test('log: quotes values containing spaces and flattens newlines', () => {
  log.error('boom', { error: 'token missing\nor expired' });
  const text = readFileSync(logPath, 'utf8');
  assert.match(text, /error="token missing\\nor expired"/);
});

test('log: serializes an Error with its stack on one line', () => {
  log.error('threw', { err: new Error('kaboom') });
  const text = readFileSync(logPath, 'utf8');
  assert.match(text, /err="Error: kaboom\\n/);
});

test('log: level filtering drops anything below the configured level', () => {
  configure({ level: 'error' });
  log.info('should-not-appear');
  log.error('should-appear');
  const text = readFileSync(logPath, 'utf8');
  assert.ok(!text.includes('should-not-appear'));
  assert.ok(text.includes('should-appear'));
  configure({ level: 'debug' });
});

test('log: rotates at max_bytes and keeps N generations', () => {
  const rotDir = mkdtempSync(path.join(os.tmpdir(), 'usage-daemon-rot-'));
  const rotPath = path.join(rotDir, 'daemon.log');
  configure({ file: rotPath, max_bytes: 500, keep: 2 });
  for (let i = 0; i < 40; i++) log.info(`line ${i} ${'x'.repeat(40)}`);
  assert.ok(existsSync(rotPath), 'live log exists');
  assert.ok(existsSync(`${rotPath}.1`), 'rotated generation 1 exists');
  assert.ok(!existsSync(`${rotPath}.3`), 'keep=2 means no third generation');
  configure({ file: logPath, max_bytes: 5 * 1024 * 1024, keep: 3 });
});

test('log: an unwritable file degrades to stderr instead of throwing', () => {
  // A path whose parent is a regular file can never be created.
  const blocker = path.join(tmp, 'blocker');
  writeFileSync(blocker, 'not a directory');
  configure({ file: path.join(blocker, 'nested', 'daemon.log') });
  assert.doesNotThrow(() => log.error('still alive'));
  configure({ file: logPath });
  assert.equal(logFile(), logPath);
});
