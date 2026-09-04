# usage-daemon-v3

Python rewrite of `usage-daemon` — poll LLM/API provider quotas and expose them
over HTTP. Zero Node/JS survives after cutover.

Authoritative design: **[`PLAN-python-rewrite.md`](PLAN-python-rewrite.md)** —
read it first. §9 describes the exact handoff sources for implementation.

## Status
- Milestone 1: project scaffold in progress (this tree).
- Reference ground truth (kept read-only as the spec):
  - JS sources + fixtures in `../usage-daemon/src/**` and `../usage-daemon/test/fixtures/`
  - this tree's `tests/fixtures/` (vendored copy of the JS fixtures)

## Layout
```
usage_daemon/       package (core modules + providers/)
tests/              pytest + fixtures
scripts/            deploy/parity helpers
pyproject.toml      python >=3.11, dep: httpx
```

## Run (scaffold)
```sh
python -m usage_daemon --help
```