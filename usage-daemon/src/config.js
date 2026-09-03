// Config loader for ~/.config/usage-daemon/config.toml.
//
// Zero-dep: a minimal TOML reader covering exactly the documented shape —
// [section.subsection] tables, key = "string" | int | true/false, # comments.
// Not a full TOML implementation; if config grows, swap for a real parser.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './log.js';

export const DEFAULT_PORT = 8787;

function configPath() {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'usage-daemon', 'config.toml');
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseValue(raw) {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  const m = v.match(/^"(.*)"$/) || v.match(/^'(.*)'$/);
  if (m) return m[1];
  return v;
}

// Minimal TOML -> nested object.
export function parseToml(text) {
  const root = {};
  let table = root;
  for (let line of text.split('\n')) {
    line = line.replace(/(^|\s)#.*$/, '').trim(); // strip comments
    if (!line) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      table = root;
      for (const key of sec[1].split('.').map((s) => s.trim())) {
        table[key] = table[key] || {};
        table = table[key];
      }
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (kv) table[kv[1]] = parseValue(kv[2]);
  }
  return root;
}

const DEFAULTS = {
  port: DEFAULT_PORT,
  providers: {
    ollama: { enabled: true, interval_seconds: 300 },
  },
};

// Load config, resolving cookie_file -> cookie. Missing file = defaults.
export async function loadConfig() {
  let parsed = {};
  const primaryPath = configPath();
  const legacyPath = path.join(process.cwd(), 'config.toml');
  
  // Try primary (XDG) first, then legacy (cwd) for migration grace
  for (const p of [primaryPath, legacyPath]) {
    try {
      parsed = parseToml(await fs.readFile(p, 'utf8'));
      if (p === legacyPath) {
        log.warn('loaded legacy config from cwd; migrate it', { from: legacyPath, to: primaryPath });
      } else {
        log.info('loaded config', { path: primaryPath });
      }
      break;
    } catch {
      // try next path
    }
  }
  if (!Object.keys(parsed).length) {
    log.warn('no config.toml found (checked XDG and cwd); using defaults', { checked: `${primaryPath},${legacyPath}` });
  }
  const cfg = {
    port: parsed.port ?? DEFAULTS.port,
    providers: { ...DEFAULTS.providers, ...(parsed.providers || {}) },
    // Opt-in control surface (restart/stop over HTTP). Off unless explicitly
    // enabled — the daemon has no per-request auth, so this stays a deliberate
    // choice for LAN/Tailscale-trusted deployments.
    control: parsed.control || {},
    // [logging] file/level/stderr/max_bytes/keep -- see log.js. Absent = the
    // defaults there (~/.local/state/usage-daemon/daemon.log, level info).
    logging: parsed.logging || {},
  };

  // resolve each provider's cookie / admin_key from *_file if not inline.
  for (const [name, pcfg] of Object.entries(cfg.providers)) {
    if (!pcfg.cookie && pcfg.cookie_file) {
      try {
        pcfg.cookie = (
          await fs.readFile(expandHome(pcfg.cookie_file), 'utf8')
        ).trim();
      } catch {
        // leave unset -> provider reports auth_expired until cookie exists.
      }
    }
    if (!pcfg.admin_key && pcfg.admin_key_file) {
      try {
        pcfg.admin_key = (
          await fs.readFile(expandHome(pcfg.admin_key_file), 'utf8')
        ).trim();
      } catch {
        // optional Admin path — vibe-only still works without it.
      }
    }
    // Bearer/Token API-key providers (openrouter, deepgram, cloudflare) keep
    // their secret in a *_file the same way cookies do — resolve each into the
    // inline field the plugin's configure() reads. Missing file = leave unset
    // -> provider reports auth_expired until the key exists.
    for (const [inline, file] of [
      ['api_key', 'api_key_file'],
      ['api_token', 'api_token_file'],
      ['token', 'token_file'],
    ]) {
      if (!pcfg[inline] && pcfg[file]) {
        try {
          pcfg[inline] = (
            await fs.readFile(expandHome(pcfg[file]), 'utf8')
          ).trim();
        } catch {
          // leave unset -> auth_expired until the key file exists.
        }
      }
    }
    cfg.providers[name] = pcfg;
  }
  return cfg;
}
