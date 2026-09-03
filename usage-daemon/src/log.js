// Structured, durable logging for the daemon.
//
// Why this exists: the daemon used to log with bare `console.error` and was
// started as `nohup node src/index.js > /tmp/usage-daemon.log 2>&1 &`. Three
// consequences, all of which cost us a diagnosis on 2026-08-18:
//   1. `>` TRUNCATES — every restart destroyed the previous run's crash
//      evidence, so a repeating crash was undiagnosable by construction.
//   2. No timestamps — death time could only be inferred from file mtime.
//   3. Nothing logged an exit, so `process.exit(0)` (the /usage/admin/stop
//      route) and an external SIGKILL looked identical: silence.
//
// Design constraints:
//   - Zero deps (the daemon has exactly one: express).
//   - Every write is `appendFileSync`. Volume is tiny (a handful of lines per
//     5-minute poll cycle) and sync is the ONLY thing that survives an
//     `exit`/`uncaughtException` handler — an async append or a buffered
//     stream write scheduled in there never lands on disk.
//   - Self-rotating by size, so an unattended daemon can't fill the disk.
//   - Writes to a file AND stderr. Under systemd, stderr is journald (free
//     timestamps + `journalctl -u`); the file survives regardless.

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

// Default log path lives beside the history state, NOT in /tmp (wiped on
// reboot — the one place a crash log must not live).
function defaultLogFile() {
  const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const base = process.env.USAGE_STATE_DIR || path.join(xdgState, 'usage-daemon');
  return path.join(base, 'daemon.log');
}

const state = {
  file: process.env.USAGE_LOG_FILE || defaultLogFile(),
  level: LEVELS[process.env.USAGE_LOG_LEVEL] ?? LEVELS.info,
  // stderr copy on by default: interactive runs want to see output, and under
  // systemd this is what lands in journald. Set USAGE_LOG_STDERR=0 when the
  // shell already redirects stderr into the same file (avoids double lines).
  stderr: process.env.USAGE_LOG_STDERR !== '0',
  maxBytes: Number(process.env.USAGE_LOG_MAX_BYTES) || 5 * 1024 * 1024,
  keep: Number(process.env.USAGE_LOG_KEEP) || 3,
  // Set once a write fails, so a broken log path degrades to stderr-only
  // instead of throwing on every single log line (a logger must never be the
  // thing that kills the process it exists to observe).
  fileBroken: false,
};

// Apply config.toml's [logging] table once it's loaded. Env vars still win —
// they're the escape hatch when the config itself is what's broken.
export function configure(opts = {}) {
  if (opts.file && !process.env.USAGE_LOG_FILE) state.file = opts.file;
  if (opts.level && process.env.USAGE_LOG_LEVEL == null) {
    const lvl = LEVELS[String(opts.level).toLowerCase()];
    if (lvl != null) state.level = lvl;
  }
  if (opts.stderr === false && process.env.USAGE_LOG_STDERR == null) state.stderr = false;
  if (opts.max_bytes && !process.env.USAGE_LOG_MAX_BYTES) state.maxBytes = Number(opts.max_bytes);
  if (opts.keep && !process.env.USAGE_LOG_KEEP) state.keep = Number(opts.keep);
  state.fileBroken = false; // give a newly configured path a fresh chance
}

export function logFile() {
  return state.file;
}

// daemon.log -> daemon.log.1 -> daemon.log.2 ... oldest dropped. Called
// inline before a write; a stat per line is cheap at this volume.
function rotateIfNeeded() {
  let size = 0;
  try {
    size = statSync(state.file).size;
  } catch {
    return; // no file yet
  }
  if (size < state.maxBytes) return;
  try {
    try { unlinkSync(`${state.file}.${state.keep}`); } catch {}
    for (let i = state.keep - 1; i >= 1; i--) {
      try { renameSync(`${state.file}.${i}`, `${state.file}.${i + 1}`); } catch {}
    }
    renameSync(state.file, `${state.file}.1`);
  } catch {
    // Rotation failing must not stop logging — keep appending to the live file.
  }
}

// Local-time ISO-ish stamp with the offset kept, so a line read months later
// still says which wall clock it happened on.
function stamp(d = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${oh}:${om}`;
}

// Extra key=value context, appended as ` k=v`. Objects/errors are stringified
// compactly; values with spaces get quoted so a line stays greppable.
function fields(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    let s;
    if (v instanceof Error) s = v.stack || v.message;
    else if (typeof v === 'object') { try { s = JSON.stringify(v); } catch { s = String(v); } }
    else s = String(v);
    s = s.replace(/\n/g, '\\n');
    parts.push(/[\s"]/.test(s) ? `${k}="${s.replace(/"/g, '\\"')}"` : `${k}=${s}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function write(level, msg, ctx) {
  if (LEVELS[level] < state.level) return;
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} usage-daemon: ${msg}${fields(ctx)}\n`;
  if (state.stderr) {
    try { process.stderr.write(line); } catch {}
  }
  if (state.fileBroken) return;
  try {
    rotateIfNeeded();
    appendFileSync(state.file, line, 'utf8');
  } catch (err) {
    try {
      mkdirSync(path.dirname(state.file), { recursive: true });
      appendFileSync(state.file, line, 'utf8');
    } catch (err2) {
      state.fileBroken = true;
      try {
        process.stderr.write(`${stamp()} ERROR usage-daemon: log file unwritable (${state.file}): ${err2.message} — stderr only from here\n`);
      } catch {}
    }
  }
}

export const log = {
  debug: (msg, ctx) => write('debug', msg, ctx),
  info: (msg, ctx) => write('info', msg, ctx),
  warn: (msg, ctx) => write('warn', msg, ctx),
  error: (msg, ctx) => write('error', msg, ctx),
  // fatal is identical mechanically (every write is already sync) — the level
  // exists so "the process is going away" greps apart from routine errors.
  fatal: (msg, ctx) => write('fatal', msg, ctx),
};

// Install process-level handlers. This is the piece that turns a silent death
// into a logged one — call it as early as possible in index.js.
//
// Covered exits:
//   uncaughtException / unhandledRejection -> logged with stack, then exit 1
//        (Node's default for both is a hard exit; we only add the record).
//   SIGTERM/SIGINT/SIGHUP/SIGQUIT         -> logged BY NAME, then onShutdown()
//   process.exit(N) from anywhere         -> 'exit' handler names the code
//        (this is what /usage/admin/stop hits — previously pure silence)
//   event loop emptied                    -> 'beforeExit' (every poll timer is
//        unref'd, so losing the listening socket exits code 0 silently)
// The only death this cannot record is SIGKILL — which is itself the
// diagnosis: no exit line in the log means something SIGKILLed us.
export function installProcessHandlers({ onShutdown } = {}) {
  let exiting = false;

  process.on('uncaughtException', (err) => {
    log.fatal('uncaught exception', { err });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log.fatal('unhandled promise rejection', {
      err: reason instanceof Error ? reason : new Error(String(reason)),
    });
    process.exit(1);
  });

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
    process.on(sig, () => {
      if (exiting) return;
      exiting = true;
      log.warn('received signal, shutting down', { signal: sig });
      if (onShutdown) onShutdown(sig);
      else process.exit(0);
    });
  }

  process.on('beforeExit', (code) => {
    log.warn('event loop drained — nothing left to keep the daemon alive', { code });
  });

  process.on('exit', (code) => {
    // Sync-only zone: this is the last thing that runs. appendFileSync is why
    // this line actually reaches disk.
    log.fatal('process exiting', { code, uptime_s: Math.round(process.uptime()) });
  });
}
