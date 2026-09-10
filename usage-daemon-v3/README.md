# usage-daemon-v3

Python rewrite of `usage-daemon` — poll LLM/API provider quotas and expose them
over HTTP. Zero Node/JS survives after cutover.

Authoritative design: **[`PLAN-python-rewrite.md`](PLAN-python-rewrite.md)** —
read it first. §9 describes the exact handoff sources for implementation.

## Status (2026-09-08 — full snapshot in [STATUS.md](STATUS.md))
- Milestone **5 of 5**: all 21 providers ported, **264 tests green**, `usage` CLI shipped.
- The daemon is fully operational; next steps are packaging, systemd cut‑over and documentation updates.
- Reference ground truth (kept read-only as the spec):
  - JS sources + fixtures in `../usage-daemon/src/**` and `../usage-daemon/test/fixtures/`
  - this tree's `tests/fixtures/` (vendored copy of the JS fixtures)

## Layout
```
usage_daemon/       package (core modules + providers/)
tests/              pytest + fixtures
scripts/            deploy/parity helpers (not yet created)
pyproject.toml      python >=3.11, dep: httpx
STATUS.md           session-continuity: progress, porting loop, gotchas
```

## Run

```sh
# Installed via pip or `uv pip install -e .`
# The console script `usage-daemon` runs the daemon (default config.toml at the repo root)
usage-daemon --port 8788   # side‑by‑side while the old JS daemon still runs on 8787
usage-daemon --help
```

## CLI — `usage`

One-shot stats view, no daemon required to *read*:

```sh
uv run usage                    # table: live daemon first, sqlite fallback
uv run usage -p claude          # single provider
uv run usage --json             # raw /usage/providers rows (jq-friendly)
uv run usage --source sqlite    # read usage.sqlite directly (daemon down OK)
uv run usage --port 8788        # explicit daemon port (default: config.toml)
```

The table shows provider, status, snapshot age, and per-window bars with
pct / used-cap / balance values, reset times, 1h deltas, and burn warnings.
`auto` source talks to the daemon over HTTP (never secrets); `sqlite` reads
`usage.sqlite` read-only (WAL-safe while the daemon runs) — history only
stores successful polls, so pct-free balance meters appear in `live` mode only.
