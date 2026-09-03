# usage-daemon

Node/Express hub: polls per-provider AI-subscription quota APIs, normalizes each to
one `windows[]` shape, serves it over HTTP. Independent git repo — parent
`/mnt/nas/projects/usage/` is a folder of repos, not a monorepo. See its `../AGENTS.md`
for the wider picture (web UI, retired GNOME extensions).

## Architecture

- `src/index.js` — entrypoint. Loads config, registers 21 compiled-in provider plugins
  (`registry.js`), starts `Runner`, mounts Express (`/usage/*` + `/metrics`), listens
  `0.0.0.0:<port>` (default 8787).
- `src/runner.js` — scheduler. Self-rescheduling `setTimeout` chain per provider (not
  fixed `setInterval`): `nextDelay(status, failures, retryAfter, base)` picks the next
  poll time — `ok` → base interval, `429 Retry-After` → honored floor, `auth_expired` →
  ~30min recheck, other errors → exponential backoff (×2/failure, capped 1h, jittered).
  30s hard fetch timeout. Never blanks a snapshot on failure — keeps last-known
  `windows`, sets `stale:true`.
- `src/providers/*.js` — one file per plugin: `ollama`, `claude`, `grok`, `mistral`,
  `opencode-go`, `openrouter`, `cloudflare`, `deepgram`, `groq`,
  `firecrawl`, `serpapi`, `llm7`, `abacus`, `hyper`, `tavily`, `context7`, `consensus`,
  `cohere`, `elevenlabs`, `runpod`, `github`. Each exports `createProvider()` with
  `config()`/`configure()`/`intervalSeconds()`/`fetch()`/pure `parse(raw)`.
  - **LLM7** (`llm7.js`): token-based quota from `api-token.llm7.io/my/token-quota`.
    Auth is a Bearer JWT (same `Authorization` header the dashboard SPA uses, from
    `dash.llm7.io`). Paste the full JWT via the WebUI Settings → the daemon persists it
    to `api_token_file` (config: `api_token_file` under `[providers.llm7]`). Single
    `daily_tokens` window with 1M token cap on free tier. Rolling 24h window, no fixed
    reset boundary (`resets_at: null`). On `setAuth`, the daemon writes the token to
    `authFile` so it survives restarts. The JWT expires in 7 days from issue — paste a
    fresh one from the dashboard before then.
  - **Abacus.AI** (`abacus.js`): compute point credits from
    `POST apps.abacus.ai/api/v1/_getCompleteUserInfo`. Auth is a browser session cookie
    (same as ollama/mistral, via `cookie_from_firefox = "abacus.ai"`). Values are in
    milli-credits (1000x); the UI divides by 1000 for display (e.g. 200,000 milli-credits
    = 2,000 credits). Single `compute_points` window with `used`/`cap`/`unit: "credits"`.
    Free tier is a one-time bucket — `resets_at: null`.
  - **Charm Hyper** (`hyper.js`): Hypercredits balance from `GET /v1/credits`
    (JSON `{"balance": 78}`). Auth is a Bearer API key (`sk-hyper-…`). Free tier
    cap is 100 credits/month (hardcoded — API doesn't return it). Reports
    `used = 100 - balance` so the bar shows consumption. **Bonus**: if a browser
    cookie is also configured (`cookie_file` + `cookie_from_firefox`), the
    provider fetches the billing page on each poll to parse
    "Next Hypercredit Refresh in N weeks" into `resets_at` — feeds the future
    calendar/renewal UI. The billing page fetch is best-effort (5s timeout,
    silently falls back to null).
  - **Context7** (`context7.js`): monthly request quota from
    `GET context7.com/api/dashboard/stats/<team_id>` (`quotaLimit`/`userRequests`).
    Auth is a Clerk session cookie whose `__session` JWT is ~60s-lived — pasting
    it manually is pointless, always run with `cookie_from_firefox = "context7.com"`
    so the daemon pulls a fresh one every poll. `team_id` (the UUID in the
    dashboard URL) is not secret, goes straight in config.toml. No reset date
    in the payload — `resets_at: null`.
  - **Consensus** (`consensus.js`): monthly Pro-message/Deep-review/Snapshot
    counters from `GET clerk.consensus.app/v1/client` — there's no
    Consensus-specific usage endpoint, the counts live in the Clerk session's
    own `public_metadata` as arrays (used = array length). Free-tier caps
    (15/3/10) are hardcoded plan constants read off the settings UI, NOT
    returned by the API — will under-report `pct` if the account isn't free.
    `resets_at` is `public_metadata.last_reset_date + 30 days` (observed cycle
    length, not documented). Same `cookie_from_firefox = "consensus.app"`
    pattern as context7 (covers the `clerk.consensus.app` subdomain cookies too).
  - **Cohere** (`cohere.js`): informational token-volume meter (no cap, no
    reset) from `POST production.api.os.cohere.com/rpc/BlobheartAPI/GetAPIUsage`,
    an undocumented dashboard RPC — Cohere's public API has no usage endpoint.
    Auth is the dashboard's session Bearer JWT (NOT the regular API key),
    lives in browser storage rather than a cookie, so `cookie_from_firefox`
    can't recover it — paste manually via WebUI Settings, re-paste when it
    expires (~5 day lifespan). `org_id` (visible in the same dashboard network
    calls) is not secret, goes in config.toml.
  - **ElevenLabs** (`elevenlabs.js`): character-credit quota from
    `GET api.elevenlabs.io/v1/user/subscription` (free call, `xi-api-key`
    header). Straightforward token auth — ported from the CodexBar reference
    (`/mnt/nas/projects/codexbar-main/docs/elevenlabs.md`). Optional `voice_slots` window
    when `voice_slots_used`/`voice_limit` are present in the response.
  - **RunPod** (`runpod.js`): pay-as-you-go dollar balance, GraphQL-only (no
    REST equivalent) — `POST api.runpod.io/graphql?api_key=...` with
    `query myself { myself { clientBalance underBalance minBalance } }`. Bare
    remaining-balance meter, no cap/reset (pay-as-you-go, not a plan).
    `will_deplete` is driven by the API's own `underBalance` flag.
  - **GitHub** (`github.js`): REST/search/graphql API call-budget from the
    free `GET api.github.com/rate_limit` — this is call quota, NOT Copilot or
    Actions usage (those live behind separate `/settings/billing/*` endpoints
    that need a `Plan: read` fine-grained PAT permission and have open
    questions about gating/semantics — not built yet, see the file's header
    comment before adding them).
- `src/http.js` — the `/usage/*` router; doc-comment at top of file lists every route,
  keep it in sync with the router when adding one.
- `src/store.js` — per-provider append-only JSONL history, `~/.local/state/usage-daemon/
  <provider>/history.jsonl`, trimmed ~20k lines. No database. `migrateLegacyHistory()`
  runs once per provider per process (marker file `.legacy-migrated`): if an old
  cwd-relative `history.jsonl` exists that the current XDG path doesn't know about, it
  gets merged in (dedup by `t`) instead of silently orphaned — this actually happened
  once (2026-08-01, ~20 days of history per provider stranded on a path-config restart,
  recovered by hand) before this safety net existed.
- `src/log.js` — the logger. Timestamped, level-tagged, key=value context, size-rotated,
  written with `appendFileSync` (the only kind of write that survives an `exit`/
  `uncaughtException` handler). Also installs the process-level handlers that log
  every exit path: uncaught exception, unhandled rejection, each signal BY NAME,
  `process.exit()` from anywhere, and event-loop drain. Default file
  `~/.local/state/usage-daemon/daemon.log` (never `/tmp` — a reboot wipes it);
  `[logging]` in config.toml or `USAGE_LOG_*` env vars override. Never redirect a
  shell `>` into the same file — that is what used to truncate away every previous
  run's crash evidence.
- `src/cookiejar.js` — reads a session cookie out of Firefox's `cookies.sqlite` so the
  cookie-auth plugins (`ollama`, `mistral`, `opencode-go`) don't need one transcribed
  by hand. Opt in per provider with `cookie_from_firefox = "<domain>"`, which enables
  `POST /usage/:provider/cookie/from-firefox` (a web-UI button) — **on request only,
  never on a timer**. The daemon keeps the stored cookie until it expires, then a human
  approves one read; a background poller reaching into the browser profile every few
  minutes would be a standing cookie-harvesting capability to re-learn something that
  changes once a month. Firefox stores values in plaintext (no keyring decrypt — that
  was Chromium-only), and the DB is copied before opening because Firefox holds it in
  WAL mode. Never writes to the profile; never logs a cookie value; a refresh that
  finds nothing fails loudly and leaves the stored cookie intact.
- `src/burnrate.js` — least-squares slope + `will_deplete` projection, purely local.
- `src/dashboard.js` / `src/report.js` — a rescue-dashboard HTML page. **Written but not
  wired**: `index.js` never imports/mounts it, `GET /` is a live 404. Don't assume it
  renders anything until this is actually mounted.

## Dev workflow

```bash
cp config.example.toml config.toml   # or ~/.config/usage-daemon/config.toml
npm install
node src/index.js      # or: npm start
npm test                # node:test, fixture-driven, per-provider parse fixtures
```

## Key design

- Daemon is **optional** — see parent repo's two-path architecture.
- `windows[]` is the contract with clients (`usage-web-ui`, GNOME extensions). No
  shared package between repos — clients only ever talk `/usage/*` HTTP.
- Never returns secrets (cookie/oauth/token values) in any response.
- OAuth-file providers (claude, grok) read the CLI's own credentials file **read-only**
  and never refresh it — expired token → `auth_expired` status, last-known windows stay.
- Binds `0.0.0.0` — no per-request auth. Keep it behind LAN/Tailscale, never a public
  WAN port.
- Every provider plugin is compiled-in via `registry.js` — no dynamic plugin loading.

## Running it (hyperion) — RESOLVED 2026-08-18, was the long-standing gotcha

The daemon now runs under a real `--user` systemd unit with `Restart=always`, so it
self-heals instead of staying dead. The repo's `usage-daemon.service` is installed at
`~/.config/systemd/user/usage-daemon.service` (`loginctl` linger is already on, so it
starts at boot without a login).

```bash
systemctl --user status usage-daemon
systemctl --user restart usage-daemon
journalctl --user -u usage-daemon -n 50 --no-pager   # or: tail ~/.local/state/usage-daemon/daemon.log
```

**Do not start an ad-hoc `nohup node src/index.js` alongside it** — that is what the
old instructions said, and a bare backgrounded process has no supervisor, is killed
silently with its process group, and truncates its own log on every restart. Exactly
one daemon: `ss -tlnp | grep 8787`.

Historical note (why the docs used to warn): before 2026-08-18 the unit was never
installed on hyperion (a stale `/etc` unit pointed at a dead `usage-daemon-modern`
subpath), so the live process was always ad-hoc and unsupervised.

## Past work

`/mnt/nas/obsidian/04-bubbAlab/09-documentation/usage/PLAN-daemon-webui-stability.md`
covers what shipped: Phase 1b path anchoring + history auto-migration (v0.3.2);
durable logging + supervised startup (v0.4.0, see `REVIEW-20260818-crash-and-logging.md`
in the same folder). Still open: wiring `dashboard.js` at `GET /` (see architecture
section above) — check that doc before starting related work.
