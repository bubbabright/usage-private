// HTTP surface (binds 0.0.0.0 — reachable from the LAN, no per-request auth;
// keep it behind the LAN/Tailscale boundary). Routes:
//   GET  /usage/health               -> daemon identity/uptime/control flags + provider counts
//   POST /usage/admin/:action        -> restart|stop|start (gated by [control] allow_control)
//   GET  /usage/headline             -> biggest mover across all providers (poll/12h/24h)
//   GET  /usage/providers            -> configured providers + status
//   GET  /usage/:provider/config     -> provider metadata (windows, tiers, auth kind)
//   GET  /usage/:provider/icon       -> icon file (?variant=dark etc, falls back to default)
//   GET  /usage/:provider/icons      -> list available icon variants
//   GET  /usage/:provider/current    -> A2 snapshot
//   GET  /usage/:provider/history    -> history rows
//   POST /usage/:provider/refresh    -> force an immediate poll, return snapshot
//   POST   /usage/:provider/cookie   -> store session cookie (daemon owns it), re-poll
//   POST   /usage/:provider/cookie/from-firefox -> read the cookie from the local
//                                      Firefox profile once (on request), store, re-poll
//   DELETE /usage/:provider/cookie   -> flush stored cookie + file, re-poll (goes auth_expired)
//   POST   /usage/:provider/auth     -> store OAuth-file/token payload, re-poll
//   DELETE /usage/:provider/auth     -> purge stored OAuth-file/token payload, re-poll (goes auth_expired)
//   GET  /                           -> multi-provider dashboard (HANDOFF-17)
//   GET  /?provider=ollama           -> self-contained HTML report

import express from 'express';
import { promises as fs, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { computeHeadline } from './headline.js';
import { expandHome } from './config.js';
import { log, logFile as defaultLogFile } from './log.js';
import { loadOverrides, saveOverride } from './usage-urls.js';

const MAX_BODY = 64 * 1024; // cookies are small; cap to avoid unbounded reads

const ICONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'providers', 'icons');
const ICON_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png' };

async function findIconFile(provider, variant) {
  const stems = variant ? [`${provider}-${variant}`, provider] : [provider];
  for (const stem of stems) {
    for (const [ext, type] of Object.entries(ICON_TYPES)) {
      try {
        const data = await fs.readFile(path.join(ICONS_DIR, `${stem}${ext}`));
        return { data, type };
      } catch { /* try next extension/stem */ }
    }
  }
  return null;
}

async function listIconVariants(provider) {
  let entries;
  try {
    entries = await fs.readdir(ICONS_DIR);
  } catch {
    return [];
  }
  const exts = Object.keys(ICON_TYPES);
  const variants = [];
  for (const name of entries) {
    const ext = exts.find((e) => name.endsWith(e));
    if (!ext) continue;
    const stem = name.slice(0, -ext.length);
    if (stem === provider) variants.push('default');
    else if (stem.startsWith(`${provider}-`)) variants.push(stem.slice(provider.length + 1));
  }
  return variants;
}

export function createApiRouter(runner, meta = {}) {
  const router = express.Router();

  const version = meta.version ?? 'unknown';
  const startedAt = meta.startedAt ?? Date.now();
  const underSystemd = Boolean(meta.underSystemd);
  const daemonDir = meta.daemonDir;
  // Getter (not the server itself): index.js builds the router before the
  // server exists. Restart needs it to release the port before respawning.
  const getServer = meta.getServer ?? (() => null);
  const control = meta.control ?? {};
  // Single opt-in flag gates every write action (start/restart/stop). Off unless
  // config.toml sets [control] allow_control = true — the daemon has no
  // per-request auth, so exposing process control is a deliberate choice.
  const controlEnabled = control.allow_control === true;
  // Where a respawned child's stdio goes. Defaults to the same file the
  // logger itself writes (~/.local/state/usage-daemon/daemon.log) — NOT
  // /tmp, which a reboot wipes, and opened for APPEND so a restart can never
  // destroy the previous run's crash evidence.
  //
  // The start hint deliberately sends the shell redirect to /dev/null: the
  // daemon's own logger owns the file now (timestamped + rotated), so a shell
  // `>` would only duplicate lines and re-introduce the truncation trap.
  // Preferred path is the systemd unit; the nohup form is the fallback.
  const logFile = expandHome(control.log_file) || defaultLogFile();
  const startHint = `systemctl --user start usage-daemon   # or: cd ${daemonDir} && nohup node src/index.js >/dev/null 2>&1 &`;

  // Respawn a detached replacement of this process. `openSync(..., 'a')` —
  // append, never truncate.
  //
  // The child cannot bind :8787 until this process has released it, so the
  // caller closes the listening socket before spawning — and index.js retries
  // a busy port for a few seconds on top of that. Without either, the child
  // hit EADDRINUSE and died instantly, leaving nothing running at all.
  // USAGE_LOG_STDERR=0 stops the child double-writing every line (its stderr
  // is already redirected into this same log file).
  function respawnDetached() {
    const fd = openSync(logFile, 'a');
    const child = spawn(process.execPath, ['src/index.js'], {
      cwd: daemonDir,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, USAGE_LOG_STDERR: '0' },
    });
    child.unref();
    return child.pid;
  }

  // Every response here is live daemon state. Without an explicit directive,
  // the browser's HTTP cache can hand a later fetch() to the same URL (e.g.
  // the UI's 30s poll) back from cache with no network round-trip at all --
  // the page looks frozen until a hard reload (Ctrl+Shift+R) bypasses it.
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.use(express.text({ limit: '64kb' }));
  router.use(express.json({ limit: '64kb' }));

  // Validate every `:provider` path segment ONCE, here, before any handler
  // touches the filesystem with it.
  //
  // Two bugs this closes:
  //   1. store.js builds `~/.local/state/usage-daemon/<provider>/` with a bare
  //      path.join, and read()/append() mkdir that directory. An unknown name
  //      therefore CREATED a junk state dir just by being requested — that is
  //      exactly where the stray `throttled/` directory came from.
  //   2. path.join with `../..` escapes the state dir entirely, so
  //      GET /usage/..%2f..%2fsomething/history was an arbitrary-path read and
  //      an arbitrary-path mkdir. Same for the icon routes, which build a
  //      filename from the segment.
  // Known providers only: the runner's own map is the allowlist.
  router.param('provider', (req, res, next, value) => {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(value) || !runner.providers.has(value)) {
      log.debug('rejected unknown provider in path', {
        provider: value,
        path: req.originalUrl,
        from: req.ip ?? req.socket?.remoteAddress ?? 'unknown',
      });
      return res.status(404).json({ error: 'unknown provider', provider: value });
    }
    return next();
  });

  // GET /usage/health — daemon identity + control capability for the web UI's
  // status panel. Read-only, always available.
  router.get('/health', (req, res) => {
    const rows = runner.list();
    let ok = 0, stale = 0, down = 0;
    for (const p of rows) {
      if (p.status === 'ok' && !p.stale) ok++;       // green
      else if (p.status === 'ok') stale++;            // ok but flagged stale
      else down++;                                    // auth_expired/rate_limited/error/pending
    }
    res.json({
      version,
      started_at: startedAt,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      under_systemd: underSystemd,
      control: {
        enabled: controlEnabled,
        // restart respawns a detached replacement of this process directly
        // (no supervisor needed); stop just exits. start can never be served
        // by this process (a stopped daemon answers nothing) — the UI shows
        // the shell command for that case.
        restart: controlEnabled,
        stop: controlEnabled,
        start: false,
      },
      providers: { total: rows.length, ok, stale, down },
    });
  });

  // POST /usage/admin/:action  (action = restart | stop | start)
  // Gated by [control] allow_control. restart spawns a detached replacement
  // process (mirrors Daniel's manual `nohup node src/index.js` invocation),
  // then exits this one; stop just exits (nothing to hand off to — there is
  // no supervisor). start is unsupported over HTTP: a stopped daemon can't
  // answer its own API, so the UI shows the shell command instead.
  router.post('/admin/:action', (req, res) => {
    const action = req.params.action;
    // Log WHO asked and for what, before anything happens. A stop/restart used
    // to be the single most invisible event in the system: the process just
    // vanished, no line anywhere, indistinguishable from a SIGKILL or a crash.
    //
    // Deliberately NOT origin-gated: this is a LAN/Tailscale-only host with no
    // open WAN ports, and the controls have to work from the dashboard, which
    // reaches the daemon through the vite proxy. The log line is the record.
    log.warn('admin action requested', {
      action,
      from: req.ip ?? req.socket?.remoteAddress ?? 'unknown',
      ua: req.get?.('user-agent') ?? undefined,
      control_enabled: controlEnabled,
    });
    if (!controlEnabled) {
      return res.status(403).json({ error: 'control disabled', hint: 'set [control] allow_control = true in config.toml' });
    }
    if (action === 'start') {
      return res.status(400).json({ error: 'start unsupported over HTTP', hint: startHint });
    }
    if (action === 'restart') {
      // Under systemd, DO NOT self-respawn. `Restart=always` already restarts
      // us on a clean exit, and a detached child stays inside the service's
      // cgroup — so systemd SIGTERMs it as part of tearing this instance down
      // while simultaneously starting its own. Best case the two race and the
      // EADDRINUSE retry in index.js sorts it out; worst case the child wins
      // the port, systemd's instance can't bind, and the unit burns through
      // StartLimitBurst. Just exit and let the supervisor do its job.
      res.json({ ok: true, action, via: underSystemd ? 'systemd' : 'respawn' });
      setTimeout(() => {
        log.warn('restarting: stopping runner and releasing the listening socket', {
          via: underSystemd ? 'systemd Restart=always' : 'self-respawn',
        });
        try { runner.stop(); } catch (err) { log.error('runner.stop failed', { err }); }
        // Close the listener FIRST so the replacement can bind the port.
        try { getServer()?.close(); } catch (err) { log.error('server.close failed', { err }); }
        if (!underSystemd) {
          try {
            const pid = respawnDetached();
            log.warn('respawned replacement daemon', { child_pid: pid, log_file: logFile });
          } catch (err) {
            log.fatal('respawn failed — daemon is going down with no replacement', { err, hint: startHint });
          }
        }
        process.exit(0);
      }, 150);
      return;
    }
    if (action === 'stop') {
      // Honest about what happens next: under systemd this is a ~5s blip, not
      // a shutdown. A real stop is `systemctl --user stop usage-daemon`.
      res.json({ ok: true, action, via: 'exit', supervised: underSystemd });
      setTimeout(() => {
        log.warn(
          underSystemd
            ? 'stopping on admin request — supervised, systemd will restart it in ~5s'
            : 'stopping on admin request — daemon will stay down until restarted',
          underSystemd ? { to_stay_down: 'systemctl --user stop usage-daemon' } : { hint: startHint },
        );
        try { runner.stop(); } catch (err) { log.error('runner.stop failed', { err }); }
        process.exit(0);
      }, 150);
      return;
    }
    return res.status(404).json({ error: `unknown action: ${action}` });
  });

  // GET /usage/providers
  router.get('/providers', (req, res) => {
    res.json(runner.list());
  });

  // GET /usage/headline
  router.get('/headline', async (req, res) => {
    const providersData = await Promise.all(
      [...runner.providers.entries()].map(async ([name, entry]) => ({
        name,
        label: entry.provider.config?.()?.label,
        current: runner.getCurrent(name),
        history: await runner.getHistory(name),
      })),
    );
    res.json(computeHeadline(providersData));
  });

  router.get('/:provider/config', (req, res) => {
    const provider = req.params.provider;
    const entry = runner.providers.get(provider);
    if (!entry) return res.status(404).json({ error: 'unknown provider', provider });
    const c = entry.provider.config?.();
    res.json(c ?? { error: 'no config' });
  });

  router.get('/:provider/icon', async (req, res) => {
    const provider = req.params.provider;
    const found = await findIconFile(provider, req.query.variant);
    if (!found) return res.status(404).json({ error: 'no icon', provider });
    res.setHeader('content-type', found.type);
    res.send(found.data);
  });

  router.get('/:provider/icons', async (req, res) => {
    res.json(await listIconVariants(req.params.provider));
  });

  router.get('/:provider/current', (req, res) => {
    const provider = req.params.provider;
    const snap = runner.getCurrent(provider);
    if (!snap) return res.status(404).json({ error: 'no snapshot yet', provider });
    res.json(snap);
  });

  router.get('/:provider/history', async (req, res) => {
    const provider = req.params.provider;
    res.json(await runner.getHistory(provider));
  });

  router.post('/:provider/refresh', async (req, res) => {
    try {
      const snap = await runner.poll(req.params.provider, { manual: true });
      res.json(snap);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:provider/cookie', async (req, res) => {
    try {
      let cookie = '';
      if (typeof req.body === 'string') {
        cookie = req.body.trim();
      } else if (req.body && req.body.cookie) {
        cookie = String(req.body.cookie).trim();
      }
      if (!cookie) return res.status(400).json({ error: 'empty cookie' });
      const snap = await runner.setCookie(req.params.provider, cookie);
      res.json(snap);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:provider/auth', async (req, res) => {
    try {
      let payload = '';
      if (typeof req.body === 'string') {
        payload = req.body.trim();
      } else if (req.body && req.body.payload) {
        payload = String(req.body.payload).trim();
      }
      if (!payload) return res.status(400).json({ error: 'empty payload' });
      const snap = await runner.setAuthPayload(req.params.provider, payload);
      res.json(snap);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /usage/:provider/cookie/from-firefox
  // One-shot, human-initiated: read this provider's session cookie out of the
  // local Firefox profile, store it exactly like a pasted one, re-poll.
  // Deliberately a button rather than a background job — the daemon should not
  // hold a standing capability to harvest browser cookies on a timer, and the
  // answer only changes when a session expires and you log back in.
  router.post('/:provider/cookie/from-firefox', async (req, res) => {
    try {
      const snap = await runner.refreshCookieFromFirefox(req.params.provider);
      res.json(snap);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/:provider/cookie', async (req, res) => {
    try {
      const snap = await runner.clearCookie(req.params.provider);
      res.json(snap);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:provider/auth', async (req, res) => {
    try {
      const snap = await runner.clearAuth(req.params.provider);
      res.json(snap);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Terminal error handler. Express 5 forwards a rejected async handler here
  // instead of crashing the process — but only if something is listening. A
  // 500 with a logged stack beats a silent hang or a bare HTML error page.
  router.use((err, req, res, next) => {
    log.error('request failed', { method: req.method, path: req.originalUrl, err });
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err?.message ?? 'internal error' });
  });

  return router;
}
