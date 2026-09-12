# STATUS — usage-daemon-v3

> Session-continuity snapshot. Last updated: **2026-09-12**.
> Fresh session? Read `PLAN-python-rewrite.md` first (architecture, locked
> decisions, §4 provider data models, §3 two-SQLite storage), then this file.

## Where we are

**All 21 providers ported AND committed. 270 tests green. Cutover done —
but NOT the way originally planned (see below).** The JS daemon and old
web UI are no longer part of this workspace at all: they were physically
relocated to `/mnt/nas/projects/usage-old` (a sibling of `/mnt/nas/projects/usage`,
outside this repo). `/mnt/nas/projects/usage/` now contains only
`usage-daemon-v3` and `usage-web-ui` — nothing else.

| Milestone | State |
|---|---|
| 1. Scaffold + core modules + 4 wire-confirmed pilots | ✅ done |
| 2. Port remaining 17 providers | ✅ done — 21/21, all committed |
| 3. Wire-parity re-run vs live JS daemon | ❌ never done — JS daemon is gone now, so this is moot |
| 4. Cutover | ✅ done — v3 running on :8788, systemd-managed. Old JS daemon retired to `usage-old`. |
| 5. Delete Node/JS tree | ✅ done (moved to `usage-old`, not deleted, by the user directly) |

- Ported (21): `ollama claude hyper cohere · abacus llm7 github runpod · mistral
  grok opencode-go openrouter cloudflare deepgram groq firecrawl serpapi tavily
  context7 consensus elevenlabs`
- Current validation: `uv run pytest -q` → **300 passed, 1 warning**
- `usage_daemon/usage_urls.py` is still a stub (no JS ground truth to port from
  anymore — it moved to `usage-old/usage-daemon/src/usage-urls.js` if still needed).

## Cutover reality (read this before touching systemd)

The plan was: swap systemd `ExecStart` to Python on port **8787** (JS's old
production port), run clean for a week, then delete JS. What actually happened:

1. Swapped the `usage-daemon.service` (`~/.config/systemd/user/`, **not** part of
   either repo) to run v3 on :8787. Confirmed working live.
2. User immediately reverted this — did **not** want the JS daemon touched at all,
   even to restore it. Instead:
3. v3 was moved to **port 8788** instead, staying systemd-managed
   (`usage-daemon.service`, `enabled`, survives reboot). Port 8787 is now
   **unused** — nothing listens there.
4. `Restart=no` is currently set on the unit ("temporarily disabled during active
   dev/testing") — if the daemon dies or is stopped, systemd will **not** bring it
   back. Re-enable with `Restart=always` + `RestartSec=5` + `daemon-reload` when
   testing settles down.
5. The JS daemon itself was separately retired by the user moving the whole
   `usage-daemon` + old `usage-web-ui-v2` trees to `/mnt/nas/projects/usage-old`.
   It is not running, not installed anywhere in this workspace, and per explicit
   standing instruction: **do not read, cd into, or otherwise touch
   `/mnt/nas/projects/usage-old` for any reason.**

Net effect: v3 is the only daemon running, on :8788, systemd-managed — just not on
the port originally planned. `usage-daemon-v3/usage-daemon.service` (the repo's
own copy of the unit, for reference/version control) should be kept in sync with
`~/.config/systemd/user/usage-daemon.service` — the live installed copy is
authoritative for now.

## Commands (all via uv — never `python3 tests/test_x.py` directly)

```sh
cd /mnt/nas/projects/usage/usage-daemon-v3
./scripts/setup_uv.sh          # one-time: create .venv, install -e .[dev]
uv run pytest -q               # whole suite (~14s)
uv run usage                   # CLI: live daemon first, sqlite fallback
uv run usage -p claude --json
systemctl --user status usage-daemon.service   # check the real running instance (:8788)
```

Environment facts:
- Config: `~/.config/usage-daemon/config.toml`. State: `~/.local/state/usage-daemon/`
  (`usage.sqlite`, `secrets.sqlite`, `daemon.log`).
- The `usage` CLI resolves the daemon port from config.toml; loopback requests
  bypass proxy env vars (`trust_env=False`). Note config.toml itself still says
  `port = 8787` — the live daemon overrides that with `--port 8788` on the
  command line (see the systemd unit). Keep this in mind if the CLI ever seems to
  be talking to nothing.
- `scripts/live-test-config.toml` is a duplicate of the real config.toml (port
  8788, `[control] service_name = "usage-daemon-v3"`) used for manual side-by-side
  testing before the systemd cutover — now redundant with the real unit, kept for
  reference.

## Storage (LOCKED — plan §3)

Two SQLite files at `~/.local/state/usage-daemon/` (honors `USAGE_STATE_DIR`),
WAL mode, foreign keys, one writer, concurrent readers. History is **unbounded**
(the JSONL 20k-line cap is gone) — no retention/pruning exists yet (code-review
flagged this, see below).

- `usage.sqlite` — the only DB the HTTP paths touch. `snapshots` (full payload per
  successful poll), `window_series`, `state`.
- `secrets.sqlite` — mode 0600, never returned over HTTP. One-time import from
  `*_file` paths on first run; after that pastes/webui writes hit the DB and
  `*_file` becomes optional.

## Depletion moved client-side

`will_deplete` / daemon-owned depletion was removed from `headline.py`. **The
user is moving the remaining client-side depletion logic (`burnrate.py`) itself
— do not touch `burnrate.py` this session or start "helping" with it
unprompted.** Separately, code review found `runner.py` strips `will_deplete`
from every window unconditionally, which throws away RunPod's real
server-computed depletion signal (`underBalance`) — see open items.

## Frontend

- `usage-web-ui` only now (the old V2/V3 A-B setup and `usage-web-ui-v2` are
  gone — moved to `usage-old`).
- Fixed this session: `OverviewBoardV3` no longer drops auth-expired/stale
  providers from the board (`usage-web-ui/src/client/App.tsx` — the
  `okProviders` filter that excluded non-`ok` providers was removed; grid/list
  cards in `GroupedCard` now always render windows). Side effect flagged by
  code review: the explicit status text badge (`auth_expired`, `rate_limited`)
  was also dropped in the same change, leaving only a small colored dot to
  signal trouble — worth a follow-up (see open items).
- No CORS headers on v3 yet — frontend must be served same-origin.
- `GET /` returns 501 (dashboard/report not ported — intentional).

## Groq provider — real usage via browser session (2026-09-11)

The Groq provider was rewritten to stop wasting API quota on fake chat
completions just to read `x-ratelimit-*` headers. It now authenticates through
the user's Firefox session (`stytch_session_jwt` or `stytch_session`) and reads
real usage from the platform activity API:

- `GET https://api.groq.com/platform/v1/organizations/{orgId}/activity`
- `stytch_session` is exchanged for a fresh JWT via the Stytch B2B SDK when the
  JWT cookie is absent
- Reports actual metrics: **cost (USD)**, **generated tokens**, **context
  tokens**, **total requests**
- Per-model daily request-limit windows for known free-tier models
  (`llama-3.1-8b-instant` = 14,400/day, whisper models = 1,000/day)
- `model_limits` config override for custom models
- Live smoke test passed against the real API (13 models, ~1,150 requests,
  ~$0.05 over 7 days — the $0.05 figure is monthly-scale; the query window
  was later corrected to 30 days, see `docs/groq.md`)

Changed: `usage-daemon-v3/usage_daemon/providers/groq.py`,
`usage-daemon-v3/tests/test_providers_groq.py`. Committed as `7f167fa`.

## This session's fixes

1. **Ollama site redesign (real bug, not code regression)** — ollama.com
   changed `/settings` around 2026-09: old "Cloud usage" heading + separate
   "Session usage"/"Weekly usage" meters are gone, replaced by one "Included
   usage" heading with a single "`<tier>` usage" meter. The old parser's
   `"Cloud usage" not in html` check was misreading every real authenticated
   page as logged-out. Fixed in `usage_daemon/providers/ollama.py`: now
   recognizes `"Included usage"` too, and emits one `windows` entry (`id:
   "usage"`) instead of `session`/`weekly`. Fixture re-vendored from a real
   (sanitized) live page. Known follow-up: only captures the *first* usage
   meter on the page — a pro-tier account with multiple meters would silently
   under-report (code review finding, not yet fixed).
2. **opencode-go**: `LABEL` renamed `"OpenCode Go"` → `"opencode.ai"` (id kept
   as `opencode-go` — no config.toml/history migration). Added a real API-key
   auth path (`GET /zen/go/v1/usage`, `Authorization: Bearer <key>`) as primary,
   falling back to the existing cookie-scrape when no key is configured — per
   steipete/CodexBar's `docs/opencode.md`. **Unverified against a live account**
   (the user no longer subscribes to OpenCode Go) — field names are a
   best-effort reconstruction of that doc's notation. Confirmed live: the
   endpoint exists, returns 401 `{"error":{"message":"Missing API key."}}`
   without a key, and a bogus `Bearer` key gets a distinct `"Unauthorized"` —
   so the URL/header mechanism is right even though the exact success-path JSON
   shape (`usage.rolling.percent` etc.) hasn't been seen for real.
3. Bare `AuthExpiredError()`/`ProviderError()` calls in opencode_go.py's new
   `_fetch_api()` now carry the server's actual error message instead of the
   generic default text (previously showed as "Rejected: provider error" in
   the webUI with no useful detail).
4. **openrouter.py**: `key.data.rate_limit` ({requests, interval}), already
   parsed into meta but previously dead-ended there, now also surfaces as an
   informational `rate_limit` window (no pct/cap) when `requests > 0`. Also
   added `RATE_LIMIT_COLOR`, a `config().windows` entry, 2 new tests, and
   updated the existing `test_parse_key_window_alone_when_credits_missing`
   (now 2 windows, not 1). Live-account check against the running daemon's
   real key found OpenRouter now sends this field with a deprecated
   `requests: -1` sentinel ("safe to ignore") on at least some keys — the
   guard correctly suppresses the window there, so it may not render for
   most/any real accounts today, but is kept since the field isn't
   documented as gone entirely. Full writeup: `docs/openrouter.md` (new).

## Session 2026-09-11/12 — groq rework, context7 Clerk refresh, burn tooling

Full writeups: `docs/groq.md`, `docs/context7.md` (new). Summary:

1. **groq.py reworked against live API + CodexBar reference**:
   - The hardcoded Stytch token (`stytch_live_637662822`) was rejected by
     Stytch with `invalid_public_token_id` (format invalid) — verified with
     a live probe — so the opaque `stytch_session` fallback could never
     auth. Replaced with Groq's real publishable console token
     (`public-token-live-…`, recovered from the console bundle and confirmed
     in CodexBar's `GroqConsoleStytch.swift`); overridable via
     `GROQ_STYTCH_PUBLIC_TOKEN` / `stytch_public_token` (env vars are now
     actually read — they never were before).
   - Auth order fixed: exchange the long-lived `stytch_session` first,
     `stytch_session_jwt` only as fallback (was inverted — a stale
     short-lived JWT was tried first). Exchange request now matches the
     console SPA: JSON body `{"session_token", "session_duration_minutes":
     30}`, base64 Stytch SDK telemetry `X-SDK-Client`, and parses the
     proxy's `data.session_jwt` shape (the old code read `session.jwt`,
     which the proxy never returns).
   - Time window fixed: 7 days → **30 days** (`ACTIVITY_HISTORY_DAYS`),
     start of UTC day −29d through end of today, matching the console
     dashboard (user-confirmed: the ~$0.05 smoke figure was monthly, and
     live rows reconcile exactly — 4,907 requests / $0.41 over 30 days).
   - `_aggregate_activity_data` tracks `requests_today` / `tokens_today`
     (current UTC day) per model; daily gauges compare today's usage to the
     per-day caps instead of pinning at 100% on period totals.
   - Daily limits from the official rate-limits docs (2026-09): RPD table
     corrected (whisper 2,000/day, gpt-oss/qwen 1,000/day, compound 250,
     orpheus 100, prompt-guard 14,400) + new TPD table with per-model
     `daily_tokens_<model>` windows (cached tokens excluded per docs).
     Both tables config-overridable (`model_limits`, `model_token_limits`).
   - Monthly windows labeled "(30d)" with `resets_at` null (they're sliding
     totals; the end-of-day countdown was misleading); daily gauges keep
     the midnight countdown — user-visible delineation between the two.
   - Empty-but-valid activity now raises `ProviderError`, not
     `AuthExpiredError` (an idle-but-healthy session must not trigger
     cookie self-heal / "re-auth needed").
   - Dead state removed (`last_agg`/`last_raw` were written, never read).
2. **context7.py: Clerk session refresh** — the bug: Context7's Clerk
   `__session` JWT lives ~60s and is only re-issued while the dashboard tab
   is open, so a Firefox cookie pulled on a 300s poll is always expired →
   401 → `auth_expired` even with a "fresh" cookie (right account, wrong
   credential lifetime). `fetch()` now decodes the `sid` from the stored
   `__session` JWT and mints a fresh JWT via
   `POST https://clerk.context7.com/v1/client/sessions/<sid>/tokens`
   (browser cookies + `Origin` only — Clerk rejects Origin+Authorization
   together; the publishable key is not needed), then calls the stats API
   with `Authorization: Bearer`. Verified live end-to-end. Clear
   `AuthExpiredError` messages when the session itself is revoked.
3. **usage-burn** — new `usage-burn` console script (`cli.burn_main`) +
   `POST /usage/:provider/burn` endpoint (gated by
   `[control] allow_control = true`) + `Runner.burn()`: injects fake usage
   into the current snapshot only (`'5%'` of cap, or a raw number; window
   selectable), so display/polling can be tested without hammering real
   APIs. The next real poll overwrites it; no history write.
4. **web-ui: pie-chart overview** — `PieCharts.tsx` (Recharts donuts +
   legend/tooltip) and `OverviewBoardPie.tsx`, toggled from the bar board
   via a session-scoped Bars/Pies view-mode toggle in `App.tsx`.
   `usage-webui.service` unit file added to the repo.
5. **Per-model daily windows are history-visible**: the daily gauges carry
   numeric `pct`, so they are historized and headlined like USD windows.



## Open items (from `/code-review`, 2026-09-09 — NONE fixed yet)

A full-project background review (8-agent fan-out: line-by-line diff, efficiency,
duplication, cross-file tracer, removed-behavior, altitude, simplification audits)
surfaced ~16 real findings. Highest priority:

1. **`runner.py` strips `will_deplete` from every window** unconditionally,
   discarding RunPod's real `underBalance`-derived signal before it ever reaches
   `list()`/HTTP/CLI.
2. **`claude.py` credential parsing, two bugs**: (a) a `json.loads` failure on
   `~/.claude/.credentials.json` now falls back to sending the *raw file text*
   as a bearer token to api.anthropic.com instead of failing fast locally; (b)
   valid-but-non-dict JSON in that file crashes with an uncaught `AttributeError`
   instead of raising `AuthExpiredError`, surfacing as a generic `error` status.
3. `_under_systemd_supervision()` (`__main__.py`) misfires for GUI-launched
   terminals (also under `app.slice`) — a manually-run daemon can get
   `under_systemd=True`, so `/usage/admin/stop` skips self-respawn and leaves it
   down indefinitely with a misleading "systemd will restart it" response.
4. `ollama.py`'s reset-time regex requires `data-time="..."` to be immediately
   followed by `>` — brittle to attribute reordering, fails silently (no error,
   `resets_at` just goes null).
5. `runner.py`'s `_mark_stale` history-fallback path matches old stored-history
   window ids against the provider's *current* config — breaks transiently after
   any provider's window schema changes (e.g. ollama's session/weekly → usage).
6. `sqlite_store.py`: one global lock serializes all reads against writes despite
   WAL mode; `Store._cache` is invalidated on every single write so it barely
   ever hits; `append()` now writes full per-poll snapshot metadata with no
   retention/pruning — unbounded growth.
7. Auth/rate-limit status-code mapping (401/403→`AuthExpiredError`,
   429→`RateLimitedError`) is copy-pasted near-verbatim into ~20 provider files
   instead of one shared helper in `errors.py`.
8. `http.py`: six near-identical try/except route handlers; `admin_action`'s
   failures are only ever logged as a string after the HTTP response already
   went out as `{"ok": true}`.
9. `hyper.py`: several sub-requests swallow transport-level failures
   (`except Exception: pass`) with no logging, degrading real infra problems
   into a silent "credits missing".
10. Overview cards lost their explicit error-status text (see Frontend section).

Full transcripts (raw, not cleaned up) live under
`~/.claude/projects/-mnt-nas-projects-usage-usage-daemon-v3/<session-id>/subagents/`
if more detail is needed than what's summarized above.

## The porting loop (complete for all 21 — kept as historical reference only)

Ground truth was the JS tree, now at `/mnt/nas/projects/usage-old/usage-daemon/`
— **do not go read it**, per standing instruction. This section is dead process
documentation; nothing left to port.

## Gotchas learned the hard way (do not re-learn)

- `from usage_daemon import registry` binds the **module** — `registry.py`
  shadows its own instance name. The singleton instance is
  `from usage_daemon.registry import registry` (tests import it `as reg`).
- The registry is a module-global singleton: tests that mutate it must
  snapshot/restore (see the `clean_registry` fixture in `tests/test_registry.py`).
- runpod `minBalance`: passes a numeric value through, absent → `null`.
- CLI live fetch must request `/usage/providers` explicitly (the daemon 404s on
  `/`), and needs `trust_env=False` on loopback or `http_proxy` breaks it.
- Balance meters (`used_is_remaining: true` — runpod, hyper) flip bar semantics:
  the fill is % remaining, not % used.
- In CLI sqlite mode, `pct_1h_ago` is recomputed client-side from compact
  history.
- **Never reference, read, or run commands against `/mnt/nas/projects/usage-old/`**
  — that's the retired JS daemon + old web UI, moved out of this workspace
  entirely and explicitly off-limits, including read-only `git status`/`ls`
  style checks from a shared parent directory.
- The systemd unit at `~/.config/systemd/user/usage-daemon.service` is NOT part
  of either git repo — it's the live source of truth for what's actually
  running. Check it directly (`systemctl --user cat usage-daemon.service`)
  rather than assuming the repo's `usage-daemon.service` file matches.
