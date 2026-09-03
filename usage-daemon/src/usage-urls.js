// Per-provider usage-page URL overrides, edited from the web UI. Separate
// tiny JSON file next to config.toml rather than a config.toml write path —
// config.toml stays hand-edited/read-only from the daemon's perspective.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function storePath() {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'usage-daemon', 'usage-urls.json');
}

// {} on missing file or bad JSON — same tolerant style as config.js's loadConfig().
export async function loadOverrides() {
  try {
    return JSON.parse(await fs.readFile(storePath(), 'utf8'));
  } catch {
    return {};
  }
}

// Empty/absent url deletes the key, falling back to the provider's default.
export async function saveOverride(provider, url) {
  const overrides = await loadOverrides();
  const trimmed = String(url || '').trim();
  if (trimmed) overrides[provider] = trimmed;
  else delete overrides[provider];

  const file = storePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(overrides, null, 2) + '\n');
  return overrides;
}
