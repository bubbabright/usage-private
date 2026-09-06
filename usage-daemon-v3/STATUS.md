# STATUS — usage-daemon-v3

> Session-continuity snapshot. Last updated: **2026-09-06** (after commit
> `00df168`). If you are a fresh session/agent picking this up: read
> `PLAN-python-rewrite.md` first (architecture, locked decisions, §4 provider
> data models), then this file (where we are, what's next, how to work).

## Where we are

**Milestone 2 of 5, 8/21 providers ported. 162 tests green. 4 commits on master.**

| Milestone | State |
|---|---|
| 1. Scaffold + 15 core modules + 4 wire-confirmed pilots (ollama, claude, hyper, cohere) | ✅ done |
| 2. Port remaining 17 providers | 🟡 **8/21 — 13 left** |
| 3. Wire-parity re-run vs live JS daemon | 🟡 one differential check done at the 111-test mark (see `FRONTEND_HANDOFF.md`); stale, re-run at M3 |
| 4. Cutover: swap systemd ExecStart, 1-week clean run | ❌ |
| 5. Delete Node/JS tree, python-only docs + deploy | ❌ |

- Ported (8): `ollama claude hyper cohere · abacus llm7 github runpod`
- Missing (13): `mistral grok opencode-go openrouter cloudflare deepgram groq
  firecrawl serpapi tavily context7 consensus elevenlabs`
- Not started: deploy artifacts (`usage-daemon.service`, `install.sh`, `scripts/`)
  and `usage_daemon/usage_urls.py` (still a stub; JS ground truth =
  `../usage-daemon/src/usage-urls.js`).
- Shipped this session: the **`usage` CLI** (`usage_daemon/cli.py` +
  `tests/test_cli.py`, 21 tests) — live-daemon/sqlite table + JSON view; and the
  **registry coverage guard** (`tests/test_registry.py`) that fails if any provider
  module is not wired into `_register_compiled_in()`.

## Commands (all via uv — never `python3 tests/test_x.py` directly)

```sh
cd /mnt/nas/projects/usage/usage-daemon-v3
uv run pytest -q                     # whole suite (~12s)
uv run usage                         # CLI: live daemon first, sqlite fallback
uv run usage -p claude --json
uv run usage-daemon-v3 --port 8788   # side-by-side boot
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

## The porting loop (for each of the 13 remaining providers)

Ground truth is the JS tree — **read it before cutover deletes it**:
`../usage-daemon/src/providers/<name>.js` plus its `../usage-daemon/test/*.test.js`.
Fixtures pin the parsers: vendored at `tests/fixtures/` (all 13 already present —
never hand-edit a fixture to make code pass; if the port disagrees with a fixture,
the port is wrong; if the fixture disagrees with the JS source, the JS source wins).

1. Port → `usage_daemon/providers/<name>.py`. Factory must be **zero-arg callable**
   (newer ports export `create()`; pilots export `create_provider(client=None)` —
   either works, `registry.create()` calls it with no args).
2. Tests → `tests/test_providers_<name>.py` (port the JS test: identical inputs →
   identical parse output; cover error/auth-expired mapping too).
3. Register in `_register_compiled_in()` in `usage_daemon/__main__.py` (imports
   alphabetical). `tests/test_registry.py` **fails if you forget** — it walks the
   package and demands module ⇄ registration parity.
4. `uv run pytest -q`, then boot side-by-side (`--port 8788`): the new provider
   must log `provider enabled`, not `config names unknown provider, skipping`.

Auth-kind batches (plan §4): cookie → `mistral opencode-go tavily context7
consensus` · oauth-file → `grok` · token → `openrouter cloudflare deepgram groq
firecrawl serpapi elevenlabs`

Fixture map: mistral → `mistral-{spend-limit,usage,vibe}.json` · grok →
`grok-usage.json` · opencode-go → `opencode-go-go.html` · openrouter →
`openrouter-{credits,key}.json` · cloudflare → `cloudflare-ai-day.json` ·
deepgram → `deepgram-balances.json` · groq → `groq-ratelimit.json` · firecrawl →
`firecrawl-credit-usage.json` · serpapi → `serpapi-account.json` · tavily →
`tavily-account.json` · context7 → `context7-stats.json` · consensus →
`consensus-client.json` · elevenlabs → `elevenlabs-subscription.json`

## Gotchas learned the hard way (do not re-learn)

- `from usage_daemon import registry` binds the **module** — `registry.py` shadows
  its own instance name. The singleton instance is
  `from usage_daemon.registry import registry` (tests import it `as reg`).
- The registry is a module-global singleton: tests that mutate it must
  snapshot/restore (see the `clean_registry` fixture in `tests/test_registry.py`).
- runpod `minBalance`: JS passes a numeric value through (`typeof === 'number'`),
  absent → `null`. The fixture test asserts the passthrough.
- CLI live fetch must request `/usage/providers` explicitly (the daemon 404s on
  `/`), and needs `trust_env=False` on loopback or `http_proxy` breaks it.
- Balance meters (`used_is_remaining: true` — runpod, hyper) flip bar semantics:
  the fill is % remaining, not % used.
- In CLI sqlite mode, `pct_1h_ago` / `will_deplete` are recomputed client-side with
  the runner's own `find_activity_base` / `will_deplete` helpers — if burnrate
  logic changes, both consumers stay in sync automatically; don't fork the math.

## Test inventory (162 total)

`test_cli 21 · test_cookiejar 19 · test_http 14 · test_runner 13 ·
test_providers_hyper 11 · test_providers_ollama 9 · test_headline 9 ·
test_history_utils 8 · test_providers_llm7 7 · test_providers_github 7 ·
test_providers_claude 7 · test_registry 6 · test_log 6 · test_timeutil 5 ·
test_store 5 · test_providers_runpod 5 · test_providers_cohere 5 ·
test_providers_abacus 5`

## Repo-root strays (not v3's; untouched on purpose)

`usage-web-ui-v2/`, `digest.txt`, `.codegraph/`, and an untracked duplicate of the
plan at `../usage-daemon/PLAN-python-rewrite.md` — the **v3 copy of the plan is the
committed, authoritative one**.
