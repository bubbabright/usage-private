# usage-web-ui

Standalone React/Vite dashboard for the `usage` suite. Split out of
`usage-daemon-modern` (2026-07-20) — see
`/mnt/nas/obsidian/04-bubbAlab/findings/FINDING-01-codexbar-supersedes-usage-panels.md`.
That finding concludes the daemon/poller backend is superseded by CodexBar, but the
thin-client web UI survives regardless of what serves its API — hence splitting it into
its own repo now, ahead of any backend swap.

## What this is

React 19 + Vite + Tailwind SPA, no router — two pages toggled by client-side state
(`App.tsx`), plus a modal. Renders whatever backend answers the `/usage/*` contract
below; no daemon-internal coupling, and it computes its own burn-rate projection
client-side rather than trusting a daemon-computed value.

- **Overview board** (landing) — one card per provider, sorted by most-recently-refreshed,
  each with a real brand-logo icon, a status dot (ok/stale/error), per-window progress
  bars, and a next-refresh countdown. Click through to a provider.
- **Provider dashboard** — per-window cards (pct or used/cap + unit), a "Force Poll" button
  (`POST /refresh`), a client-side "Deplete: ~in Xh" projection, and a Recharts history line
  chart with quick-zoom range buttons (5h/12h/1d/7d/All, persisted across providers/reloads
  in `localStorage`).
- **Per-provider settings** — a gear icon on each sidebar row (not a separate page) opens
  a modal with that provider's auth form (cookie / oauth-file / token, per `auth.kind`),
  a "Connected" badge, and its visibility toggle (`localStorage`, hides it from
  sidebar/overview/headline without touching daemon polling).
- **HeadlineBar** (pinned, top) — polls `/usage/headline` every 30s, surfaces the single
  biggest %-point mover across all providers and a "depleting soon" alert.
- **DaemonPanel** (sidebar, bottom) — polls `/usage/health` every 5s for daemon
  version/uptime/ok-stale-down counts, plus Restart/Stop buttons gated by the daemon's
  reported `control` flags.

## API contract expected

```
GET  /usage/health               daemon identity/uptime, control flags, provider counts
POST /usage/admin/:action        restart|stop|start (gated by [control] allow_control)
GET  /usage/headline             biggest %-point mover across all providers (poll/12h/24h)
GET  /usage/providers            configured providers + status
GET  /usage/:provider/config     provider metadata (windows, tiers, auth kind)
GET  /usage/:provider/icon       icon file (?variant=dark etc)
GET  /usage/:provider/icons      list available icon variants
GET  /usage/:provider/current    latest snapshot
GET  /usage/:provider/history    history rows
POST /usage/:provider/refresh    force an immediate poll, return snapshot
POST   /usage/:provider/cookie   store session cookie, re-poll
DELETE /usage/:provider/cookie   flush stored cookie, re-poll (goes auth_expired)
POST   /usage/:provider/auth     paste oauth-file JSON or token, re-poll
DELETE /usage/:provider/auth     purge stored oauth-file/token, re-poll (goes auth_expired)
```

Today that's served by `usage-daemon` (`../usage-daemon/`, `node src/index.js`, port 8787).
Longer-term candidate per the finding: an adapter over `codexbar usage --format json`
(shape differs — fixed `primary`/`secondary`/`tertiary` slots vs. this repo's generic
`windows[]` — would need a small mapping layer, not covered here).

## Dev

```sh
npm install
npm run dev        # vite dev server, proxies /usage/* -> 127.0.0.1:8787 (see vite.config.ts)
```

Requires a backend answering the contract above running on the proxy target (default
`usage-daemon`, `node src/index.js` in that repo, port 8787).
Change the proxy target in `vite.config.ts` if pointing at something else.

## Build

```sh
npm run build       # -> dist/, static, serve from any web server or reverse proxy
```

## Layout

Full-width top header with logo left, daemon controls + settings gear right. Sidebar
contains only the provider nav (collapse toggle at top). The old sidebar-bottom
`DaemonPanel` was relocated to the top header, and the logo/title block was removed from
the sidebar.

## Deployment (hyperion / 192.168.1.196)

- **Systemd user service:** `systemctl --user status usage-web-ui`
  - `Restart=always`, `RestartSec=5`
  - `ExecStart=npm run dev -- --host 0.0.0.0 --port 5173`
  - Survives reboot (`loginctl enable-linger daniel` on host)
- **Caddy (192.168.1.10):** Proxies `usage.hoboguppy.com` → `192.168.1.196:5173`
- **Daemon API:** Proxied via Caddy at `/usage/*` → daemon on `:8787`

(End of file - total 52 lines)