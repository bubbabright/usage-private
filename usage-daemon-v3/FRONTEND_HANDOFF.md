# Frontend Agent Handoff — usage-daemon-v3 backend API

> **Status: READY (backend core).** 162 tests green via `uv run pytest` (~12s),
> boot → poll → SIGTERM verified live, and wire-contract parity with the JS daemon
> confirmed shape-for-shape (differential check against the live JS instance,
> below — performed at the 111-test mark, before four more providers landed;
> a fresh parity re-run is planned for milestone 3, see `STATUS.md`).
>
> Provider coverage note: v3 currently runs **8/21 providers** (ollama, claude,
> hyper, cohere, abacus, llm7, github, runpod). Until cutover, the JS daemon on
> 8787 still serves all 21 — develop against it; the shapes below are identical.

## What runs where

- **JS daemon (v0.5.0, production, 21 providers):** port **8787** — keep it running; the frontend can develop against it today.
- **Python daemon (v3):** same routes, same JSON shapes, default port 8787 — run it instead with `--port <other>` if side-by-side (`uv run usage-daemon-v3 --port 8788`), or point it at the same config.
- Repo: `/mnt/nas/projects/usage/usage-daemon-v3` (config: `port = <n>` top-level key in config.toml).

## The API (all routes under /usage)

| Method | Route | Notes |
|---|---|---|
| GET | `/usage/health` | version, uptime_s, provider counts, control flags |
| GET | `/usage/providers` | **main list endpoint** — array of provider rows |
| GET | `/usage/headline` | poll/12h/24h deltas + depleting warning |
| GET | `/usage/{provider}/current` | snapshot; **404** `{"error":"no snapshot yet"}` before first poll |
| GET | `/usage/{provider}/history` | compact rows, oldest→newest (10k+ rows live) |
| GET | `/usage/{provider}/config` | provider's config.toml view |
| POST | `/usage/{provider}/cookie` | raw cookie body → 200 snapshot (or 400 empty) |
| DELETE | `/usage/{provider}/cookie` | clears → re-poll snapshot |
| POST | `/usage/{provider}/cookie/from-firefox` | 400 with clear message if it fails |
| POST | `/usage/{provider}/auth` | raw token body (token providers) |
| DELETE | `/usage/{both}` | `{"error": "control disabled"}` 403 when `[control] allow_control` is false |
| POST | `/usage/{provider}/refresh` | manual re-poll → snapshot |
| GET | `/metrics` | Prometheus text (outside /usage) |

All unknown things → 404 `{"error": ...}`; unknown provider under /usage → 404 `{"error":"unknown provider"}`.

## Wire contract — captured live from the JS daemon (v3 emits the same)

**GET /usage/providers → 200, array of rows:**

```json
{
  "provider": "ollama",
  "status": "ok",                  // "ok" | "auth_expired" | "rate_limited" | "error" | "pending"
  "stale": false,                  // true when error'd; snapshot may be hours old
  "t": 1788534401987,              // snapshot epoch ms (null until first poll)
  "tier": "free",
  "error": null,                   // string on failure, e.g. "Grok token missing or expired"
  "last_success_t": 1788534401987, // epoch ms or null (never succeeded)
  "consecutive_failures": 0,
  "next_poll_at": 1788534728118,   // epoch ms; may be in the past if poll overdue
  "cookie_from_firefox": "ollama.com",  // null for token providers
  "cookie_expires_at": null,       // ISO string or null
  "category": "plan",
  "windows": [
    {
      "id": "session", "label": "Session", "letter": "Se",
      "pct": 0,                       // 0-100 number or null
      "used": 0, "cap": 10000,        // numbers or null (absent-capacity providers have null)
      "unit": "neurons",              // string or null
      "used_is_remaining": false,     // some providers report remaining, not used
      "color": "#E69F00",
      "cycles_remaining": null,
      "resets_at": "2026-09-04T16:00:00-04:00",  // ISO 8601 with local offset or null
      "will_deplete": false,          // burn-rate says it hits 100% before reset
      "pct_1h_ago": 0                 // number or null (no history yet)
    }
  ]
}
```

Real failure row (render stale rows greyed with `error` shown):

```json
{
  "provider": "grok", "status": "auth_expired", "stale": true,
  "error": "Grok token missing or expired", "t": 1787837264278,
  "last_success_t": null, "consecutive_failures": 12
}
```

**GET /usage/headline → 200:**

```json
{
  "poll": null,
  "12h": {"provider": "claude", "provider_label": "Claude Code", "window_id": "weekly",
          "window_label": "7d", "color": "#56B4E9", "from_pct": 19, "to_pct": 0, "delta": -19},
  "24h": { ...same shape... },
  "depleting": null   // or {provider, provider_label, window_id, window_label, color, resets_at}
}
```

**GET /usage/{p}/history → 200, array of compact rows (oldest→newest):**

```json
{"t": 1788534401987, "tier": "free", "session": 0, "weekly": 4.8}
```
Window pct values are flattened to top-level keys by window id; rows with no
numeric pct for a window simply omit that key. Segment-bearing providers also
store `segments` (e.g. ollama: `[{"model": "gemma4:31b", "requests": 61}]`).

**GET /usage/health → 200:**

```json
{"version": "0.5.0", "started_at": 1788514600204, "uptime_s": 19896,
 "under_systemd": true,
 "control": {"enabled": true, "restart": true, "stop": true, "start": false},
 "providers": {"total": 21, "ok": 18, "stale": 0, "down": 3}}
```

## Frontend behavior rules (worth encoding)

- `status != "ok"` or `stale: true` → grey the row; show `error` text; still render `windows` from the stale snapshot (they may be hours old).
- `pct` may be `null` (provider gives no %) — fall back to `used`/`cap` when present, else show label only.
- `used_is_remaining: true` flips the fill semantics — `pct` is % *remaining*, not used.
- `resets_at` is an ISO string with local offset — render with local formatting; it is **not** epoch ms.
- Poll deltas: prefer computing from `pct_1h_ago` per window; headline gives 12h/24h.
- Timestamps are **epoch milliseconds** (`t`, `last_success_t`, `next_poll_at`, `started_at`); only `resets_at`/`cookie_expires_at` are ISO 8601 strings.

## What's tested (111 tests, all green)

| Area | File | Count |
|---|---|---|
| Providers (claude, hyper, cohere, ollama) | `tests/test_providers_*.py` | 32 |
| Runner scheduling/poll/auth | `tests/test_runner.py` | 13 |
| HTTP surface (routes, codes, bodies) | `tests/test_http.py` | 14 |
| Cookie parsing (FF ms-stamp trap) | `tests/test_cookiejar.py` | 14 |
| Headline, burnrate, history, store, time, log | `tests/test_{headline,store,...}.py` | 38 |

Contract guards live in `tests/test_http.py` — if a route shape drifts, CI catches it before the frontend feels it.

## Known gaps (explicitly out of scope for the frontend)

- `GET /` returns 501 (dashboard/report not ported — that's this handoff).
- Not yet ported from JS (13): mistral, grok, opencode-go, openrouter,
  cloudflare, deepgram, groq, firecrawl, serpapi, tavily, context7, consensus,
  elevenlabs. Ported: ollama, claude, hyper, cohere, abacus, llm7, github, runpod.
- `usage_urls.py` (state-backed usage-URL overrides) is a stub.
- No CORS headers on v3 yet — frontend must be served same-origin (or we add CORS when needed).
- Docs, install.sh, dashboard.js/report.js — cutover chores, see `STATUS.md`.

## How to verify a frontend change

```bash
cd /mnt/nas/projects/usage/usage-daemon-v3 && uv run pytest -q   # backend green?
# against the live JS daemon (today):
curl -s localhost:8787/usage/providers | jq '.[0]'
# against v3 (after switching over): same command, same shapes
```

