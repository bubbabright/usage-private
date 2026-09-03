// Per-provider append-only history. One JSON object per successful poll,
// mirrors the extensions' history.jsonl contract but namespaced by provider.
// ~/.local/state/usage-daemon/<provider>/history.jsonl, trimmed to ~20k lines.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './log.js';

const MAX_LINES = 20000;

function stateDir(provider) {
  const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const override = process.env.USAGE_STATE_DIR;
  const base = override || path.join(xdgState, 'usage-daemon');
  return path.join(base, provider);
}

function historyPath(provider) {
  return path.join(stateDir(provider), 'history.jsonl');
}

// One-time-per-process safety net: if a prior cwd-relative stateDir() (the
// pre-XDG behavior) left a history.jsonl behind that the current XDG-based
// path doesn't know about, merge it in instead of silently orphaning it --
// this is exactly what happened once already (ollama et al. stranded ~20
// days of history when the daemon started reading from ~/.local/state
// instead of <cwd>/.local/state after a restart). Runs at most once per
// provider per process (marker file), so normal append()/read() calls after
// the first stay a plain stat + no-op.
const legacyMigrationChecked = new Set();

async function migrateLegacyHistory(provider) {
  if (legacyMigrationChecked.has(provider)) return;
  legacyMigrationChecked.add(provider);

  const newPath = historyPath(provider);
  const legacyPath = path.join(process.cwd(), '.local', 'state', 'usage-daemon', provider, 'history.jsonl');
  if (legacyPath === newPath) return;

  const dir = stateDir(provider);
  const marker = path.join(dir, '.legacy-migrated');
  try {
    await fs.access(marker);
    return; // already handled in a previous run
  } catch {}

  let legacyLines = [];
  try {
    legacyLines = (await fs.readFile(legacyPath, 'utf8')).split('\n').filter(Boolean);
  } catch {
    // no legacy file -- nothing to migrate, just mark so we don't stat again
  }

  await fs.mkdir(dir, { recursive: true });
  if (legacyLines.length) {
    let newLines = [];
    try {
      newLines = (await fs.readFile(newPath, 'utf8')).split('\n').filter(Boolean);
    } catch {}
    const rows = new Map(); // t -> line, dedupe by timestamp (new-path rows win on collision)
    for (const line of [...legacyLines, ...newLines]) {
      try {
        rows.set(JSON.parse(line).t, line);
      } catch {}
    }
    const merged = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line);
    await fs.writeFile(newPath, merged.join('\n') + '\n', 'utf8');
    log.info('migrated legacy history rows (cwd-relative -> XDG state dir)', {
      provider, rows: legacyLines.length,
    });
  }
  await fs.writeFile(marker, '', 'utf8').catch(() => {});
}

// Flatten a snapshot's windows into a compact history row.
export function historyRow(snapshot) {
  const row = { t: snapshot.t, tier: snapshot.tier };
  for (const w of snapshot.windows) {
    if (w.pct != null) row[w.id] = w.pct;
  }
  return row;
}

export async function append(provider, snapshot) {
  await migrateLegacyHistory(provider);
  const dir = stateDir(provider);
  await fs.mkdir(dir, { recursive: true });
  const line = JSON.stringify(historyRow(snapshot)) + '\n';
  await fs.appendFile(historyPath(provider), line, 'utf8');
  await trim(provider).catch(() => {});
}

async function trim(provider) {
  const p = historyPath(provider);
  let text;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n').filter(Boolean);
  if (lines.length <= MAX_LINES) return;
  const kept = lines.slice(lines.length - MAX_LINES);
  await fs.writeFile(p, kept.join('\n') + '\n', 'utf8');
}

// Parsed-history cache, keyed by provider and invalidated on any change to the
// file's size or mtime.
//
// Why: read() was re-reading AND re-JSON.parsing the entire ~20k-line history
// on every single poll (runner._doPoll) and, worse, for EVERY provider on every
// /usage/headline request — which the web UI polls on a timer. With ten
// providers at ~400 KB each that is ~4 MB of string + tens of thousands of
// short-lived objects per request, for files that only change once per poll
// interval. Pure garbage pressure on a long-lived process.
//
// Callers treat the rows as read-only (burnrate, history-utils, JSON
// responses), so handing back the same array is safe.
const readCache = new Map(); // provider -> { mtimeMs, size, rows }

export async function read(provider) {
  await migrateLegacyHistory(provider);
  const p = historyPath(provider);

  let stat;
  try {
    stat = await fs.stat(p);
  } catch {
    readCache.delete(provider);
    return [];
  }
  const hit = readCache.get(provider);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.rows;

  let text;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch {
    return [];
  }
  const rows = text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  readCache.set(provider, { mtimeMs: stat.mtimeMs, size: stat.size, rows });
  return rows;
}
