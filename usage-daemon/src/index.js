#!/usr/bin/env node
// usage-daemon entry point. Loads config, registers compiled-in provider plugins,
// wires the runner, and starts the HTTP surface on 0.0.0.0:<port> (LAN-reachable
// — the daemon is trusted on the local network; there is no per-request auth, so
// keep it behind the LAN/Tailscale boundary, never a public WAN port).

// IPv4-only outbound (must be first — before any provider fetch). Lab has no
// working IPv6; dual-stack undici fetch times out on AAAA-bearing hosts.
import './ipv4.js';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, DEFAULT_PORT, expandHome } from './config.js';
import { log, configure as configureLog, logFile, installProcessHandlers } from './log.js';
import * as registry from './registry.js';
import { Runner } from './runner.js';
// import { createServer } from './http.js';

// Daemon identity for the /usage/health panel: version from package.json, the
// moment this process booted (for uptime), whether systemd owns us (informational
// only — no systemd unit is installed today, see AGENTS.md), and this package's
// own root dir so the admin/restart route can respawn `node src/index.js` in
// place without needing a supervisor.
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const DAEMON_VERSION = PKG.version ?? 'unknown';
const STARTED_AT = Date.now();
const UNDER_SYSTEMD = Boolean(process.env.INVOCATION_ID);
const DAEMON_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- register providers (compiled-in) ---
import { createProvider as createOllama } from './providers/ollama.js';
registry.register('ollama', createOllama);
import { createProvider as createClaude } from './providers/claude.js';
registry.register('claude', createClaude);
import { createProvider as createGrok } from './providers/grok.js';
registry.register('grok', createGrok);
// mistral registered but off by default (config enabled=false); enable in
// config.toml when testing. Does not load unless enabled.
import { createProvider as createMistral } from './providers/mistral.js';
registry.register('mistral', createMistral);
import { createProvider as createOpencodeGo } from './providers/opencode-go.js';
registry.register('opencode-go', createOpencodeGo);
// API-key/token providers below are registered but off by default; enable in
// config.toml with their api_key/api_token. They do not load unless enabled.
import { createProvider as createOpenRouter } from './providers/openrouter.js';
registry.register('openrouter', createOpenRouter);
import { createProvider as createCloudflare } from './providers/cloudflare.js';
registry.register('cloudflare', createCloudflare);
import { createProvider as createDeepgram } from './providers/deepgram.js';
registry.register('deepgram', createDeepgram);
import { createProvider as createGroq } from './providers/groq.js';
registry.register('groq', createGroq);
import { createProvider as createFirecrawl } from './providers/firecrawl.js';
registry.register('firecrawl', createFirecrawl);
import { createProvider as createSerpapi } from './providers/serpapi.js';
registry.register('serpapi', createSerpapi);
import { createProvider as createLlm7 } from './providers/llm7.js';
registry.register('llm7', createLlm7);
import { createProvider as createAbacus } from './providers/abacus.js';
registry.register('abacus', createAbacus);
import { createProvider as createHyper } from './providers/hyper.js';
registry.register('hyper', createHyper);
import { createProvider as createTavily } from './providers/tavily.js';
registry.register('tavily', createTavily);
import { createProvider as createContext7 } from './providers/context7.js';
registry.register('context7', createContext7);
import { createProvider as createConsensus } from './providers/consensus.js';
registry.register('consensus', createConsensus);
import { createProvider as createCohere } from './providers/cohere.js';
registry.register('cohere', createCohere);
import { createProvider as createElevenlabs } from './providers/elevenlabs.js';
registry.register('elevenlabs', createElevenlabs);
import { createProvider as createRunpod } from './providers/runpod.js';
registry.register('runpod', createRunpod);
import { createProvider as createGithub } from './providers/github.js';
registry.register('github', createGithub);

// Process-level crash/exit logging is installed BEFORE anything else runs, so
// a failure during config load or provider registration is recorded too. The
// real teardown is swapped in once the server exists.
let shutdownHook = () => process.exit(0);
installProcessHandlers({ onShutdown: (sig) => shutdownHook(sig) });

async function main() {
  const cfg = await loadConfig();
  // [logging] from config.toml (file/level/stderr/max_bytes/keep). Anything
  // logged before this line already went to the default path, so a config
  // that itself fails to load is still recorded.
  configureLog({ ...(cfg.logging ?? {}), file: expandHome(cfg.logging?.file) });
  log.info('daemon starting', {
    version: DAEMON_VERSION,
    pid: process.pid,
    node: process.version,
    cwd: process.cwd(),
    under_systemd: UNDER_SYSTEMD,
    log_file: logFile(),
  });
  const runner = new Runner();

  for (const [name, pcfg] of Object.entries(cfg.providers)) {
    if (pcfg.enabled === false) continue;
    if (!registry.has(name)) {
      log.warn('config names unknown provider, skipping', { provider: name });
      continue;
    }
    const provider = registry.create(name);
    provider.configure?.(pcfg);
    // authFile: the daemon-owned file a pasted token/OAuth payload is written
    // back to (so a webui Settings paste endures a restart). Pick whichever
    // *_file this provider's secret was configured from — first one wins.
    const authFile = pcfg.api_token_file || pcfg.api_key_file || pcfg.token_file || pcfg.credentials_path;
    runner.add(provider, {
      cookieFile: expandHome(pcfg.cookie_file),
      authFile: expandHome(authFile),
      // Opt-in: pull this provider's session cookie straight out of Firefox
      // before each poll instead of relying on a hand-pasted one. Value is the
      // registrable domain to collect cookies for (subdomains included), e.g.
      // cookie_from_firefox = "mistral.ai" covers console. and admin. both.
      cookieFromFirefox: pcfg.cookie_from_firefox || null,
    });
    log.info('provider enabled', {
      provider: name,
      interval_s: provider.intervalSeconds?.() ?? 300,
      cookie_from_firefox: pcfg.cookie_from_firefox || undefined,
    });
  }

  runner.start();
  
  const app = (await import('express')).default();
  const { createApiRouter } = await import('./http.js');
  // `server` is created below; the router only ever needs it later (the
  // restart route closes the listener before respawning), so hand it a getter.
  let server;
  app.use('/usage', createApiRouter(runner, {
    version: DAEMON_VERSION,
    startedAt: STARTED_AT,
    underSystemd: UNDER_SYSTEMD,
    daemonDir: DAEMON_DIR,
    control: cfg.control ?? {},
    getServer: () => server,
  }));
  
  app.get('/metrics', (req, res) => {
    const lines = [];
    // HELP/TYPE must appear exactly once per metric name in a single
    // exposition — Prometheus rejects the scrape on a duplicate HELP line.
    // Emit them up front, then one sample row per provider/window.
    lines.push(`# HELP usage_provider_status Provider status (1=ok, 0=not ok)`);
    lines.push(`# TYPE usage_provider_status gauge`);
    lines.push(`# HELP usage_window_pct Window usage percentage`);
    lines.push(`# TYPE usage_window_pct gauge`);
    for (const [name, snap] of runner.current.entries()) {
      if (!snap || snap.status !== 'ok') continue;
      lines.push(`usage_provider_status{provider="${name}"} ${snap.status === 'ok' && !snap.stale ? 1 : 0}`);
      for (const w of snap.windows ?? []) {
        if (w.pct != null) {
          lines.push(`usage_window_pct{provider="${name}",window="${w.id}"} ${w.pct}`);
        }
      }
    }
    res.setHeader('content-type', 'text/plain; version=0.0.4');
    res.send(lines.join('\n') + '\n');
  });

  server = (await import('node:http')).createServer(app);

  // A listen failure emits 'error' on the server, NOT a promise rejection —
  // without a handler EADDRINUSE was an unhandled 'error' event that threw
  // out of the event loop with nothing on disk explaining it.
  //
  // EADDRINUSE is retried for a few seconds because the restart route spawns
  // this process while the outgoing one may still hold the socket. Retries
  // exhausting means someone ELSE owns :8787 — refuse to start rather than
  // spin, so we never end up with two daemons fighting over one port.
  const LISTEN_RETRY_MS = 500;
  const LISTEN_RETRIES = 12; // ~6s of grace for the outgoing process to exit
  let listenAttempt = 0;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && listenAttempt < LISTEN_RETRIES) {
      listenAttempt++;
      log.warn('port busy, retrying listen', {
        port: cfg.port, attempt: listenAttempt, of: LISTEN_RETRIES,
      });
      setTimeout(() => server.listen(cfg.port, '0.0.0.0'), LISTEN_RETRY_MS);
      return;
    }
    if (err.code === 'EADDRINUSE') {
      log.fatal('port still in use after retries — another daemon owns it, refusing to start', {
        port: cfg.port, hint: `ss -tlnp | grep ${cfg.port}`,
      });
    } else {
      log.fatal('http server error', { err });
    }
    process.exit(1);
  });

  server.listen(cfg.port, '0.0.0.0', () => {
    log.info('listening', { url: `http://0.0.0.0:${cfg.port}`, pid: process.pid });
  });

  // Daemon-specific teardown, called by the signal handlers installed above
  // (they log which signal arrived before getting here).
  shutdownHook = () => {
    runner.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
}

main().catch((err) => {
  log.fatal('failed to start', { err });
  process.exit(1);
});
