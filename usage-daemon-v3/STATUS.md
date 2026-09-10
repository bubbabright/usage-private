# STATUS — usage-daemon-v3

> Session-continuity snapshot. Last updated: **2026-09-08**.
> Fresh session? Read `PLAN-python-rewrite.md` first (architecture, locked
> decisions, §4 provider data models, §3 two-SQLite storage), then this file.

## Where we are

**Milestone 5 of 5. All 21 providers ported. 264 tests green. `usage` CLI shipped.**
The daemon is fully operational; remaining work is packaging, systemd cut-over,
documentation, and a handful of frontend open items (below).

| Milestone | State |
|---|---|
| 1. Scaffold + core modules + 4 wire-confirmed pilots (ollama, claude, hyper, cohere) | ✅ done |
| 2. Port remaining 17 providers | ✅ done — 21/21 |
| 3. Wire-parity re-run vs live JS daemon | 🟡 one differential check done at the 111-test mark (stale); re-run at cutover |
| 4. Cutover: swap systemd ExecStart, 1-week clean run | ❌ |
| 5. Delete Node/JS tree, python-only docs + deploy | ❌ |

- Ported (21): `ollama claude hyper cohere · abacus llm7 github runpod · mistral
  grok opencode-go openrouter cloudflare deepgram groq firecrawl serpapi tavily
  context7 consensus elevenlabs`
- Current validation: `uv run pytest -q` → **264 passed, 1 warning**
- Shipped this session: the **`usage` CLI** (`usage_daemon/cli.py` + `tests/test_cli.py`)
  — live-daemon/sqlite table + JSON view; the **registry coverage guard**
  (`tests/test_registry.py`) that fails if any provider module is not wired into
  `_register_compiled_in()`; and **`scripts/setup_uv.sh`** to bootstrap a uv env.
- Not started: deploy artifacts (`usage-daemon.service`, `install.sh`) and
  `usage_daemon/usage_urls.py` (still a stub; JS ground truth =
  `../usage-daemon/src/usage-urls.js`).

## Commands (all via uv — never `python3 tests/test_x.py` directly)

```sh
cd /mnt/nas/projects/usage/usage-daemon-v3
./scripts/setup_uv.sh          # one-time: create .venv, install -e .[dev]
uv run pytest -q               # whole suite (~12s)
uv run usage                   # CLI: live daemon first, sqlite fallback
uv run usage -p claude --json
uv run usage-daemon --port 8788  # side-by-side boot
```

Environment facts:
- The **JS daemon (v0.5.0) owns port 8787** (production, under systemd). Leave it
  running until cutover — the frontend develops against it and the CLI falls back
  gracefully.
- v3 booted without `--port` reads the same `config.toml` (`port = 8787`), retries
  ~6s, then **refuses to start** rather than double-bind. That refusal is correct
  behavior, not a bug.
- Config: `~/.config/usage-daemon/config.toml`. State: `~/.local/state/usage-daemon/`
  (`usage.sqlite`, `daemon.log`). Both daemons share paths; secrets live in
  `secrets.sqlite` (never over HTTP).
- The `usage` CLI resolves the daemon port from config.toml; loopback requests
  bypass proxy env vars (`trust_env=False`).

## Storage (LOCKED — plan §3)

Two SQLite files at `~/.local/state/usage-daemon/` (honors `USAGE_STATE_DIR`),
WAL mode, foreign keys, one writer, concurrent readers. History is **unbounded**
(the JSONL 20k-line cap is gone).

- `usage.sqlite` — the only DB the HTTP paths touch. `snapshots` (full A2 payload
  per successful poll), `window_series` (denormalized per-window % time-series for
  client-side depletion + headline lookbacks), `state` (usage_urls overrides,
  migration markers, daemon identity/version).
- `secrets.sqlite` — mode 0600, never returned over HTTP. One-time import from
  `*_file` paths on first run; after that pastes/webui writes hit the DB and
  `*_file` becomes optional.

## Depletion moved client-side

`will_deplete` / daemon-owned depletion was **removed from the backend**. The
SQLite history is faithfully populated; clients (the `usage` CLI and the web UI)
derive depletion from history + `resets_at` instead of a server-provided flag.
The wire field is kept (defaults false) for contract compatibility.

## Frontend

- `usage-web-ui` (V2 layout) and `usage-web-ui-v2` (V3 redesign with
  `OverviewBoardV3`) live side-by-side; V3 is A/B'd against V2 and defaults to V2.
- Frontend behavior rules (grey stale rows, `used_is_remaining` flip, ISO
  `resets_at`, epoch-ms timestamps, client-side depletion) are encoded in
  `FRONTEND_HANDOFF.md`.
- No CORS headers on v3 yet — frontend must be served same-origin (or add CORS
  when needed).
- `GET /` returns 501 (dashboard/report not ported — intentional; that work is the
  frontend's job).

## Open items

### 1. Overview auth-expired visibility fix (frontend, NOT started)

When a provider's auth expires (e.g. **context7**), it currently **disappears
from the Overview board**. It should remain visible — greyed/stale, showing its
last-known windows + the `error` text — exactly like a stale row elsewhere.

Root cause is in `OverviewBoardV3` (`usage-web-ui/src/client/App.tsx`, mirrored in
`usage-web-ui-v2`):

```tsx
// A provider that's erroring (auth_expired etc.) or stale has nothing current
// to show — it stays in the sidebar (still flagged there in red) but drops out
// of the Overview board entirely rather than taking up card space with dead data.
const okProviders = providers.filter((p) => p.status === 'ok' && !p.stale);
```

This filter discards auth_expired/stale providers before they reach the cards. The
daemon keeps the last-known snapshot (windows intact) on error, so the data to
render is available — only the filter hides it.

Fix direction: stop excluding non-ok providers from the board; render them in a
greyed/error state with their stale `windows` (the board already has a red-dot +
`status (stale)` block for `p.status !== 'ok'`). The sidebar already keeps them;
the board should too. Requested end of last session — not yet implemented.

### 2. Wire-parity re-run (milestone 3)

The single differential check against the live JS daemon was done at the
111-test mark and is stale. Re-run a fresh shape-for-shape diff before cutover.

### 3. Deploy artifacts + migration

Create `usage-daemon.service`, `install.sh`, and the one-time JSONL/secret-file →
two-SQLite migration with a marker so it runs once.

### 4. Cutover + JS deletion (milestones 4–5)

Swap systemd `ExecStart` to the Python entry; run 1 week clean; then delete the
entire Node/JS tree and update README/AGENTS/ARCHITECTURE to be Python-accurate.

## The porting loop (complete for all 21 — kept as a reference)

Ground truth is the JS tree — **read it before cutover deletes it**:
`../usage-daemon/src/providers/<name>.js` plus its
`../usage-daemon/test/*.test.js`. Fixtures pin the parsers: vendored at
`tests/fixtures/` (all present — never hand-edit a fixture to make code pass; if
the port disagrees with a fixture, the port is wrong; if the fixture disagrees
with the JS source, the JS source wins).

1. Port → `usage_daemon/providers/<name>.py`. Factory must be a **zero-arg
   callable** (newer ports export `create()`; pilots export
   `create_provider(client=None)` — either works).
2. Tests → `tests/test_providers_<name>.py` (identical inputs → identical parse
   output; cover error/auth-expired mapping too).
3. Register in `_register_compiled_in()` in `usage_daemon/__main__.py` (imports
   alphabetical). `tests/test_registry.py` **fails if you forget**.
4. `uv run pytest -q`, then boot side-by-side (`--port 8788`): the new provider
   must log `provider enabled`, not `config names unknown provider, skipping`.

## Gotchas learned the hard way (do not re-learn)

- `from usage_daemon import registry` binds the **module** — `registry.py`
  shadows its own instance name. The singleton instance is
  `from usage_daemon.registry import registry` (tests import it `as reg`).
- The registry is a module-global singleton: tests that mutate it must
  snapshot/restore (see the `clean_registry` fixture in `tests/test_registry.py`).
- runpod `minBalance`: JS passes a numeric value through, absent → `null`. The
  fixture test asserts the passthrough.
- CLI live fetch must request `/usage/providers` explicitly (the daemon 404s on
  `/`), and needs `trust_env=False` on loopback or `http_proxy` breaks it.
- Balance meters (`used_is_remaining: true` — runpod, hyper) flip bar semantics:
  the fill is % remaining, not % used.
- In CLI sqlite mode, `pct_1h_ago` is recomputed client-side from compact
  history.

## Repo-root strays (not v3's; untouched on purpose)

`usage-web-ui-v2/`, `digest.txt`, `.codegraph/`, and an untracked duplicate of
the plan at `../usage-daemon/PLAN-python-rewrite.md` — the **v3 copy of the plan
is the committed, authoritative one**.
