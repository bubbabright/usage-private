# usage-daemon

Always-on (LXC) daemon that **owns** usage polling for the usage suite.
**Node/JS**, Express-based. Framework + runner. Each provider is a compiled-in
**plugin**. Plugins today: **ollama**, **claude**, **grok**, **mistral**, **opencode-go**,
**openrouter**, **cloudflare**, **deepgram**, **groq**, **firecrawl**, **serpapi**.
Default bind: `0.0.0.0:8787` — reachable from the LAN so the daemon and web UI
are usable from any host on the local network. There is **no per-request auth**
(any LAN host can set cookies/keys and force polls), so keep it behind the
LAN/Tailscale boundary — never expose it on a public WAN port.

## One line

One poller. One secret store. One `windows[]` snapshot. Every thin client is just a view.

## Why I run a daemon

Without it, every panel and every laptop polls Anthropic / xAI / ollama.com on its own timer.
With a shared subscription and several humans (plus agents), that is uncoordinated sources of
truth against APIs that already rate-limit chatter.

The daemon is the **optional** hub of the two-direction system (see the meta
[`../README.md`](../README.md)), not a hard dependency.

- **Solo path:** Claude and Grok GNOME exts still self-poll with their own engines. Dual-mode
  (prefer this daemon when it is up) is the plan, not fully wired in every ext yet. Ollama's
  GNOME ext is a thin client of this daemon today.
- **Hub path:** [multi-provider-usage-extension](https://github.com/bubbabright/multi-provider-usage-extension)
  and `usage-web-ui` read the same registry (a `GET /` rescue dashboard is planned but not yet
  wired — see below). Add a plugin here → every client lights up with **no extension code
  change**. I proved that with Grok.

I own auth handling, parse, history, burn-rate, and polling interval. Clients render. Cookie
endpoints never echo the cookie back. OAuth-file plugins read the same credentials file the
CLI already owns, **read-only**, and **never refresh the token** (expired → `auth_expired`,
last-known windows stay).

## Install / update

### Dev checkout

```sh
git clone https://github.com/bubbabright/usage-daemon.git
cd usage-daemon
cp config.example.toml config.toml
npm install
node src/index.js          # or: npm start
```

Config.toml is read from the current working directory.

### Production install

```sh
curl -fsSL https://raw.githubusercontent.com/bubbabright/usage-daemon/main/install.sh | bash
```

Idempotent. Re-run any time to pull the latest and restart. Clones (or `git pull --ff-only`
on an existing install) into `~/.local/share/usage-daemon`, checks Node.js ≥ 20, writes a
default `config.toml` on first run, and sets up a `systemd --user` service so it survives
reboots.

### systemd (manual)

A ready unit ships in the repo: [`usage-daemon.service`](usage-daemon.service)
(`Restart=always`, `RestartSec=5`, `WorkingDirectory` = the checkout so cwd-relative
`config.toml` + `.config/usage-daemon/*.cookie` resolve). Install as a user service:

```sh
cp usage-daemon.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now usage-daemon
systemctl --user restart usage-daemon    # one-command restart after code changes
loginctl enable-linger "$USER"            # (optional) start at boot without login
```

## MCP server (planned): control plane, not a second dashboard

Not implemented yet. Thin MCP server over the **same** provider registry: provider-agnostic
`get_usage(provider)` for any MCP client, not Claude-only.

**Core purpose: control plane, not a dashboard.** Live cross-provider quota state is a
cost-aware inference-orchestration signal for local infra (LiteLLM, olla, batch queues).
Rule of thumb:

```
already-paid subscription headroom  →  free/cheap serverless  →  bigger GPU only when needed
```

Gateways know dollars through the pipe. They usually do not know what is left on my Claude
weekly window while Claude Code and night agents burn it outside the proxy. This layer is
that headroom.

Consistent with: **never auto-spend quota just to refresh a status token.**

## Run

```bash
npm start                   # node src/index.js
npm test                    # fixture-driven unit tests (node:test)
```

Config: `./config.toml` (in cwd, see `config.example.toml`). Providers are
enabled there with per-provider intervals and auth paths.

## HTTP surface

| Method | Path | Returns |
|--------|------|---------|
| GET | `/usage/health` | daemon identity/uptime, `under_systemd`, control flags, provider ok/stale/down counts |
| POST | `/usage/admin/:action` | `restart`\|`stop`\|`start` — gated by `[control] allow_control` |
| GET | `/usage/providers` | configured providers + status |
| GET | `/usage/{provider}/config` | metadata (label, `auth.kind`, window descriptors) |
| GET | `/usage/{provider}/icon` | icon bytes (`?variant=` optional) |
| GET | `/usage/{provider}/icons` | list of icon variants |
| GET | `/usage/{provider}/current` | normalized snapshot (below) |
| GET | `/usage/{provider}/history` | history rows (window ids as keys, plus `t`, `tier`) |
| GET | `/usage/headline` | biggest %-point movers per scope across all providers |
| POST | `/usage/{provider}/refresh` | force an immediate poll, return snapshot |
| POST | `/usage/{provider}/cookie` | store session cookie (daemon owns it), re-poll |
| POST | `/usage/{provider}/auth` | store OAuth-file or token payload, re-poll |
| DELETE | `/usage/{provider}/cookie` | flush stored cookie, re-poll (goes `auth_expired`) |
| DELETE | `/usage/{provider}/auth` | purge stored OAuth-file/token payload, re-poll (goes `auth_expired`) |
| GET | `/metrics` | Prometheus text format |
| GET | `/` | planned rescue dashboard (`dashboard.js`/`report.js`) — not yet wired, 404 today |

### Headline (`/usage/headline`)

Returns the biggest %-point movers per time scope (poll/12h/24h) and any
depleting-soon windows across ALL providers — so a big jump doesn't go
unnoticed just because you're looking at a different provider's tab.

### Supplying the cookie (cookie-auth providers)

Ollama, Mistral, OpenCode Go auth on the browser **session cookie** (not an API key).
Claude and Grok use `auth.kind: oauth-file`. Either way the **daemon owns** cookie secrets:
persists to `cookie_file` at mode `0600`, uses them, **never returns them** from any endpoint.

- **File:** put the cookie in the path from `config.toml` and restart (or wait for next poll).
- **Endpoint:** `POST /usage/{provider}/cookie` with the cookie as `text/plain` or
  `{"cookie":"..."}` JSON. The daemon writes it and immediately re-polls.

```bash
curl -X POST --data 'session=...; other=...' 127.0.0.1:8787/usage/ollama/cookie
curl -X POST --data-binary @mistral.cookie 127.0.0.1:8787/usage/mistral/cookie
```

### Snapshot (daemon-to-client contract)

```json
{
  "provider": "ollama",
  "t": 1783250789974,
  "tier": "free",
  "status": "ok",
  "stale": false,
  "windows": [
    {
      "id": "session",
      "label": "Session",
      "pct": 0,
      "resets_at": "2026-07-11T10:00:00-04:00",
      "color": "#E69F00",
      "will_deplete": false
    },
    {
      "id": "weekly",
      "label": "Weekly",
      "pct": 0,
      "resets_at": "2026-07-13T00:00:00-04:00",
      "color": "#56B4E9",
      "will_deplete": false
    }
  ],
  "segments": []
}
```

`status`: `ok | auth_expired | rate_limited | error`. On any error the daemon keeps the
last-known `windows` and sets `stale: true`. Never invents zero to look fresh.

**`windows[]` array order is display order.** Clients map / forEach in array order.
They do not sort by duration.

Additive snapshot/list fields (thin clients may ignore them; `windows[]` unchanged):
`error` (last failure message), `last_success_t`, `consecutive_failures`, `next_poll_at`.

### Reliability / recovery

The runner is self-rescheduling (not a fixed `setInterval`), so a provider that
falls off **heals itself** instead of hammering a dead endpoint:

- **Retry-After honored** — a `429` with `Retry-After` sets the next poll no sooner
  than that (never re-pokes a throttled endpoint early).
- **Exponential backoff** — repeated errors double the delay (floored at the base
  interval, capped at 1h) with jitter; a success resets to the base interval.
- **auth_expired** re-checks on a slow (~30 min) cadence so a re-login is picked up
  without a restart.
- **In-flight guard** — a scheduled tick and a manual `/refresh` share one fetch.
- **30s fetch timeout** — a hung/slow provider can't stall the poller.
- **Logging** — every failure (with consecutive count) and every stale→ok recovery
  is logged to stderr/journal; no more silent rot.

| Provider | Windows in snapshot |
|---|---|
| ollama | `session`, `weekly` |
| claude | `session` (5h), `weekly` (7d) |
| grok | `weekly`, `monthly` |
| mistral | `vibe_monthly`, `api_monthly` (ready-made % via `billing.budget`; `vibe_monthly` backs off to a capped interval once at 100% until reset), optional `monthly_spend` ($, Admin key) |
| opencode-go | `5h`, `weekly`, `monthly` |
| openrouter | `key_limit`, `credits` (balance meters, no reset) |
| cloudflare | `neurons` (daily, resets 00:00 UTC) |
| deepgram | `balance` (prepaid $, no reset) |
| groq | `daily_requests` (RPD), `tpm` (per-minute, noisy) |
| serpapi | `monthly_searches` (resets at `plan_renewal_date`), or `total_searches` bare-count fallback for credit-pool accounts |

All datetime fields are normalized to the **host's local time zone** as ISO-8601 with
an explicit offset.

### Auth kinds

Clients branch on `config().auth.kind`:

- `cookie` — browser session cookie (ollama, mistral, opencode-go). POST to `/cookie`.
- `oauth-file` — reads CLI credentials file directly (claude, grok). POST to `/auth`
  to supply the file content without the daemon needing filesystem access to the
  credential path.
- `token` — plain API key/Bearer token (openrouter, cloudflare, deepgram, groq,
  serpapi). POST to `/auth` (same as oauth-file — a raw string, provider-interpreted)
  to set it, DELETE `/auth` to purge it (goes `auth_expired`).

## Layout

```
src/
  index.js       entry: load config, register providers, start runner + HTTP
  config.js      minimal TOML loader
  registry.js    compiled-in provider registry (name -> factory)
  runner.js      scheduler; normalizes to snapshot, stores history, computes will_deplete
  store.js       per-provider history.jsonl
  burnrate.js    least-squares slope + depletion projection
  headline.js    cross-provider % movement aggregation (/usage/headline)
  http.js        HTTP surface, binds 0.0.0.0/LAN (API + SPA serving)
  time.js        host-local ISO timestamps
  providers/
    ollama.js    poll ollama.com/settings (cookie) + parse(html)
    claude.js    poll api.anthropic.com/api/oauth/usage (oauth-file) + parse(json)
    grok.js      monthly billing + gRPC-web (oauth-file) + parse(envelope)
    mistral.js   vibe tRPC (cookie) + optional Admin /usage÷spend-limit
    opencode-go.js  scrape opencode.ai/workspace/go (cookie) + local CLI db fallback
    serpapi.js   free Account API (token via ?api_key=) + parse(json)
test/
  …              fixture-driven parse / burnrate tests
```

The React SPA lives in `src/client/` (built by Vite). In dev mode, Vite middleware
serves it; in production, static `dist/` files are served.

## Storage: aggregate SQLite (planned)

Today: per-provider `history.jsonl` via `store.js`, trimmed to ~20k lines, at
`$XDG_STATE_HOME/usage-daemon/<provider>/` (default `~/.local/state/...`). If a
prior cwd-relative history file exists there from before this path was fixed, it's
merged in automatically on first read/write per provider (once per process, dedup by
timestamp) rather than silently orphaned.

Planned: **one SQLite DB** for all providers so history is not capped the way
extension history files are. The daemon is a separate process; that ceiling
need not apply.

**Future:** export to Prometheus / Grafana / Power BI.

## Always-on service (LXC 24/7 + mobile)

Running the daemon in an **LXC** gives 24/7 collection independent of the daily-driver
desktop.

- **Complete history, captures automated / background spend.** Desktop off no longer means
  a data gap. Scheduled tasks, cron agents, background coworkers burn quota while you are away.
- **Mobile use.** Continuous collection, served beyond the GNOME panel.
- **On-the-go dashboard via Tailscale.** Expose the dashboard over a Tailscale private mesh.

## Adding a provider

1. `src/providers/<name>.js` exporting `createProvider()` → object with
   `name`/`label`, `auth`, `config()`, `configure(cfg)`, `intervalSeconds()`, `fetch()`,
   pure `parse(raw)` → `{ tier, windows, segments }`, optional `meta()`.
2. `registry.register('<name>', createProvider)` in `index.js` (compiled in on purpose).
3. Enable it in `config.toml`.
4. Order `windows[]` the way clients should show bars by default.
   Keep pure `parse()` fixture-tested under `test/`.

Auth kinds clients already branch on: `'cookie' | 'oauth-file'`. New providers
should reuse those kinds when possible.

## Related projects

- [multi-provider-usage-extension](https://github.com/bubbabright/multi-provider-usage-extension)
- [claude-usage-extension](https://github.com/bubbabright/claude-usage-extension)
- [supergrok-usage-extension](https://github.com/bubbabright/supergrok-usage-extension)
- [ollama-cloud-usage-extension](https://github.com/bubbabright/ollama-cloud-usage-extension)
- [usage-web-ui](https://github.com/bubbabright/usage-web-ui)
