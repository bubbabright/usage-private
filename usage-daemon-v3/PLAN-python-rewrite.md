# PLAN — Rewrite `usage-daemon` in Python (zero Node/JS remains)

Status: **LOCKED** (data models, storage, framework, rollout all approved).
This copy (`usage-daemon-v3/PLAN-python-rewrite.md`) is the **authoritative,
committed version**; the untracked duplicate in the JS tree
(`/mnt/nas/projects/usage/usage-daemon/PLAN-python-rewrite.md`) predates it.

## 0. Mandate

The ported Python package becomes the **sole** implementation of the daemon.
After cutover the entire Node/JS tree is deleted — `src/`, `package.json`,
`package-lock.json`, `bun.lock`, all `test/*.js` — and the deployment scripts
target Python only. The `/usage/*` + `/metrics` HTTP surface and the `windows[]`
snapshot contract must be **wire-identical** so `usage-web-ui`,
`usage-web-ui-v2`, and the GNOME extensions do not notice the swap.

## 1. Stack (all-Python, dep-light)

- Python >= 3.11 — stdlib `asyncio`, `tomllib`, `sqlite3`, `http.server`,
  `subprocess`, `datetime`.
- One runtime dependency: **`httpx`** (async HTTP; replaces undici `fetch`).
- HTML scraping stays **`re`** (fixtures pin the regexes); Firefox cookies via
  **`sqlite3`** (copy-before-read, WAL-safe); `claude --version` detection and
  the /admin/restart respawn via **`subprocess`**.

### Async model
- One `asyncio.Task` per provider = the self-rescheduling chain (not a fixed
  interval), reproducing `runner.js` `next_delay()` + `jitter()`.
- `asyncio.wait_for(fetch(), 30)` reproduces the 30s hard fetch timeout.
- Shared in-flight guard per provider (`in_flight` dedup) so a scheduled tick
  and a manual `/refresh` share a single fetch.
- SQLite calls run through `asyncio.to_thread` (blocking I/O off the loop).

## 2. Target layout

```
usage-daemon/
  pyproject.toml   usage-daemon.service   install.sh   scripts/
  usage_daemon/
    __main__.py config.py registry.py runner.py sqlite_store.py burnrate.py
    headline.py http.py log.py cookiejar.py timeutil.py httputil.py
    history_utils.py usage_urls.py errors.py
    providers/  (21 files: ollama claude grok mistral opencode_go openrouter
                 cloudflare deepgram groq firecrawl serpapi llm7 abacus hyper
                 tavily context7 consensus cohere elevenlabs runpod github)
  tests/  (pytest + vendored fixtures; JS test files deleted)
```

Same `config.toml`, same secret `*_file` paths (one-time import), same
`~/.local/state/usage-daemon/` base dir, so existing config and history carry
over unchanged.

## 3. Storage: two SQLite files (LOCKED)

Location: `~/.local/state/usage-daemon/` (honors `USAGE_STATE_DIR`). WAL mode,
foreign keys, one writer, concurrent readers. History is **unbounded** (the
JSONL 20k-line cap is gone — that was the point of the SQLite move).

### `usage.sqlite` — the only DB the HTTP paths touch
- `snapshots(provider TEXT, t INTEGER, tier TEXT, raw_json TEXT, PRIMARY KEY(provider, t))`
  — every successful poll, full A2 payload (windows/segments/meta).
- `window_series(provider TEXT, window_id TEXT, t INTEGER, pct REAL, INDEX(provider, window_id, t))`
  — denormalized per-window % time-series for client-side depletion math and
  `headline` (poll/12h/24h lookbacks, `pct_1h_ago`).
- `state(key TEXT PRIMARY KEY, value TEXT)` — usage_urls overrides, migration
  markers, daemon identity/version.

### `secrets.sqlite` — never returned over HTTP
- `secrets(provider TEXT, kind TEXT, value TEXT)` — cookies / oauth-file
  payloads / api keys / tokens (`kind` in cookie|oauth-file|api_token|api_key|token).
- Mode 0600. One-time import from today's `*_file` paths on first run; after
  that, pastes and webui writes hit the DB and `*_file` becomes optional.
- The HTTP layer never reads this DB.

### One-time migration
Import existing `~/.local/state/usage-daemon/<provider>/history.jsonl` ->
`snapshots` + `window_series`; read existing `*_file` secrets and
`usage-urls.json` -> `secrets` / `state`. Record a migration marker so it runs
once. After migration the JSONL/JSON/secret plain files are no longer written
## 4. Locked provider data models (all 21 approved)

Auth kinds: **cookie** (ollama, mistral, opencode-go, abacus, context7,
consensus, tavily + hyper's HTML source), **oauth-file** (claude, grok),
**token** (openrouter, cloudflare, deepgram, groq, firecrawl, serpapi, llm7,
hyper, cohere, elevenlabs, runpod, github). SerpApi/runpod pass the key as a
query param; the rest as Bearer (deepgram uses `Token`, elevenlabs `xi-api-key`).

| # | Provider | Windows / data fetched (locked) |
|---|---|---|
| 1 | ollama | session(0%)+resets_at, weekly(4.8%)+resets_at; tier free; segments per-model (gemma4:31b 61) |
| 2 | claude | session 5h / weekly 7d / extra_usage; meta.token_expires_at; `claude --version` UA detection |
| 3 | mistral | as current JS |
| 4 | grok | as current JS |
| 5 | cohere | **trailing-month** tokens + **calls quota from x-ratelimit-\* headers** (used=4, cap=300, resets_at=reset) + per-model segments + daily meta |
| 6 | llm7 | daily_tokens 10609/1M pct 1.06; tier free_token; 24h rolling -> learn reset (best-effort resets_at) |
| 7 | hyper | hypercredits used=100-20=80, cap 100; tier free; per-model segments (in/out/cache/total, Hc, $); resets_at from "Next Hypercredit refresh in 2 weeks" |
| 8 | openrouter | key_limit from server remaining when available (else reset-window usage fallback), `resets_at = limit_reset` when present, plus credits balance tile; meta rate_limit{requests,interval} + usage_{daily,weekly,monthly} |
| 9 | opencode-go | 5h/weekly/monthly $ windows (GO caps 12/30/60); local CLI sqlite hybrid; workspace id |
| 10 | tavily | credits usage/limit (**resets_at = last_reset**); tier = current_plan |
| 11 | context7 | requests/mo used/cap; resets_at null (no date in payload); tier = owner_plan |
| 12 | abacus | compute_points (raw centi-credits /100); **resets_at = freeTierExpiresAt = expiry**, expires_at, note |
| 13 | deepgram | balance $ (sum across projects); pct only vs config balance_cap; meta balance_usd |
| 14 | firecrawl | credits balance as **slices** (remaining-as-plan-slices), cycles_remaining; resets_at = period_end |
| 15 | serpapi | monthly_searches used/cap (**resets_at = plan_renewal_date**) or bare total_searches_left |
| 16 | cloudflare | daily_neurons used/cap w/ free 10000/day (**resets_at = next UTC midnight**; pct may exceed 100); segments per-model |
| 17 | groq | daily_requests from x-ratelimit-\*-requests headers (**resets_at from duration string**); 900s cadence |
| 18 | elevenlabs | characters used/cap (**resets_at = next_character_count_reset_unix**); meta uses `account_status` not `status` |
| 19 | consensus | pro_messages(15)/deep_reviews(3)/snapshots(10); **resets_at = last_reset + 30d** |
| 20 | runpod | balance $ (clientBalance, used_is_remaining); surface `under_balance` in meta |
| 21 | github | REST/search/graphql call budgets from /rate_limit; **resets_at = resource.reset** each |
## 5. Standing rules (applied across all providers)

1. **Refresh-window capture.** Long / planning windows (14 / 21 / 30d) MUST
   surface `resets_at` (cohere month, hyper 2w, serpapi renewal, firecrawl
   period_end, consensus +30d). Short / rolling windows (24h, cloudflare daily,
   groq RPD) are best-effort or learned from history.
2. **Support providers = balance tile + exchange rate.** Real cap -> real `pct`;
   otherwise bare balance (`used_is_remaining`, no fabricated percent). Surface
   the rate / headroom in `meta` (`x-ratelimit-*`, `rate_limit{requests,interval}`,
   firecrawl cycle slices).
3. **Never fabricate.** No reset the API doesn't give (context7 stays null); no
   invented `pct` (runpod / deepgram stay balance-meters); fail-soft stale
## 6. Module mapping (name-for-name port of the JS)

| Python module | JS source | Notes |
|---|---|---|
| `__main__.py` | `index.js` | entry: load config, register providers, start runner + HTTP |
| `config.py` | `config.js` | tomllib; same keys + `*_file` resolution |
| `registry.py` | `registry.js` | compiled-in name->factory map |
| `runner.py` | `runner.js` | self-rescheduling task, next_delay, jitter, 30s wait_for, 429 Retry-After floor + manual bypass, in_flight dedup, _mark_stale disk fallback, firefox self-heal once-guard |
| `sqlite_store.py` | `store.js` | two-DB schema, async wrappers, migration, unbounded history |
| `burnrate.py` | `burnrate.js` | least-squares slope helper for client-side depletion math |
| `headline.py` | `headline.js` | poll/12h/24h movers |
| `http.py` | `http.js` | `/usage/*` + `/metrics` (text/plain 0.0.0.4), no-store, 64kb body, provider allowlist / path-traversal guard |
| `log.py` | `log.js` | sync append, size rotate, dual file+stderr, signal/exit handlers |
| `cookiejar.py` | `cookiejar.js` | copy-before-read, per-domain, on-request only |
| `timeutil.py` | `time.js` | to_host_iso (host-local, numeric offset, fail-soft) |
| `httputil.py` | `ipv4.js` | IPv4-first resolution wrapper for httpx |
| `history_utils.py` | `history-utils.js` | find_value_at_or_before, activity base |
| `usage_urls.py` | `usage-urls.js` | overrides (now in `state`) |
| `errors.py` | (new) | AuthExpiredError / RateLimitedError protocol |

**Dead code NOT ported** (per ARCHITECTURE.md): `dashboard.js`, `report.js`,
and the icon routes/assets.
   snapshots keep last-known windows on error.
## 7. Tests & acceptance

- Port all `test/*.test.js` -> `pytest` with vendored fixtures (identical
  inputs -> identical outputs for every `parse`, plus `next_delay`,
  `headline`, store, cookiejar, time, log). Keep the burn-rate helper tested as
  a client-side utility, not daemon-owned output.
- Integration test: boot runner + `http.server` on a free port with stub
  providers; assert golden `/usage/*` + `/metrics` responses.
- Side-by-side parity script against the live Node daemon before deletion.
- **Cutover:** swap systemd `ExecStart` to the Python entry; run 1 week clean;
  then delete all Node/JS; update README / AGENTS / ARCHITECTURE to be
  Python-accurate; python-only deploy scripts.

## 8. Rollout milestones

1. Scaffold `usage_daemon/` + core (config, registry, errors, sqlite_store,
   burnrate, log, runner, http, timeutil, httputil, history_utils, usage_urls)
   + four wire-confirmed pilots (ollama, claude, hyper, cohere) with pytest
   fixture ports; dev systemd instance on a test port for the parity check.
2. Port remaining 17 providers in batched pytest cycles by auth kind.
3. Full wire-parity check + side-by-side diff vs live Node.
4. Cutover (swap ExecStart), 1-week clean run.
5. Delete Node/JS; update docs; python-only deploy scripts.

---

## 9. Session handoff — what implementation MUST re-read first

This plan was shaped through a planning session against the live daemon and real
upstream responses. A fresh implementation session should anchor on these sources,
in order, before writing provider code:

1. **This plan file** — authoritative for architecture, storage (two-SQLite split),
   standing rules, and the locked provider data models (§4).
2. **Existing JS source still on disk** — ground truth for every provider's wire
   call and parse, including the approved-as-is providers (mistral, grok,
   opencode-go, tavily, context7, abacus, deepgram, firecrawl, serpapi, cloudflare,
   groq, elevenlabs, consensus, runpod, github). Read `src/providers/*.js` and the
   matching `test/*.test.js` + `test/fixtures/` to re-derive exact endpoints,
   headers, regexes, and shapes. Fixtures pin the parsers — do not hand-edit them.
3. **Wire-confirmed pilots** — live responses captured during planning must be
   treated as ground truth for these four:
   - `ollama`: `GET https://ollama.com/settings` (cookie) → session 0% + `data-time`
     resets, weekly 4.8% + `data-time`, per-model segments (`data-usage-segment`).
   - `claude`: `GET https://api.anthropic.com/api/oauth/usage` (oauth-file) →
     session/weekly/extra_usage windows; `claude-code/<ver>` UA gates real 429s.
   - `hyper`: `GET /v1/credits` (Bearer) → balance; plus
     `GET /teams/<id>/dashboard` (cookie) → tier, per-model usage table, and the
     "Next Hypercredit refresh in …" countdown → `resets_at`. cap = 100; used =
     100 − balance. (Team id visible at `https://hyper.charm.land/teams/6b4e808f-…`.)
   - `cohere`: `POST https://production.api.os.cohere.com/rpc/BlobheartAPI/GetAPIUsage`
     (Bearer dashboard-session JWT, ~5-day expiry) with `before`/`after` bounding
     **one trailing calendar month**; extract tokens + a `calls` window from the
     **response headers** `x-ratelimit-limit: 300`, `x-ratelimit-remaining`,
     `x-ratelimit-reset` (used = limit − remaining). See `PLAN`'s notes — the
     response headers are the missing quota, not the body.
4. **Deployment env facts** — systemd unit + `install.sh` + `config.toml` +
   `*_file` secret paths live in the daemon repo; data at
   `~/.local/state/usage-daemon/`. The one-time migration must import existing
   `*_file` values into `secrets.sqlite` and leave them optional.
(and are deleted at cutover).