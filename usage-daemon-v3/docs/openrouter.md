---
summary: "OpenRouter provider (usage-daemon-v3): key limit, rate_limit window, credits balance, and free-requests daily tier via the Management analytics API."
read_when:
  - Debugging OpenRouter API key usage or spend parsing
  - Updating OpenRouter windows, the rate_limit field, or the free_requests window
  - Explaining OpenRouter provider behavior in this daemon
  - Setting up an OpenRouter Management key for request-count tracking
  - Exploring other Management-key endpoints (keys list, activity feed, models catalog)
---

# OpenRouter Provider

Implementation: `usage_daemon/providers/openrouter.py`.
Tests: `tests/test_providers_openrouter.py` (fixtures: `openrouter-key.json`,
`openrouter-credits.json`, `openrouter-analytics.json`).

## Data Source

Read-only calls with `Authorization: Bearer <key>`, polled on a 300s interval
(`interval_seconds()`), never a completions call:

1. `GET /api/v1/key` — spending cap (`limit`), usage, `is_free_tier`,
   `is_management_key`, `byok_usage*`, and `rate_limit`.
2. `GET /api/v1/credits` — lifetime `total_credits` purchased and
   `total_usage`, from which balance is derived.
3. `POST /api/v1/analytics/query` — Management API. Body:
   `{"metrics": ["request_count"], "granularity": "day",
   "time_range": {"start": "<ISO>", "end": "<ISO>"}}` with `start` = today's
   UTC midnight and `end` = next UTC midnight (future-dated end is accepted;
   the in-progress day bucket is included). Response rows arrive as
   `{"date__day": "YYYY-MM-DD", "request_count": "84"}` — **`request_count`
   is a STRING**; the parser coerces and sums all rows.

Either GET failing with 401/403 raises `AuthExpiredError` only if **both**
are denied; 429 raises `RateLimitedError` honoring `Retry-After`. A single
endpoint being down still lets the other populate its window. The analytics
POST is **best-effort and independently degrading**: any failure (403 on a
plain inference key, network error, malformed body) just omits the
`free_requests` window and sets `_openrouter.free_requests_auth = "degraded"`
— it never fails the poll.

### Management key setup

The analytics endpoint requires a **Management key** (create at
https://openrouter.ai/settings/management-keys); plain inference keys get 403.
No separate config slot: the same bearer key is sent to all three endpoints,
and one Management key works for all of them (verified live 2026-09-11 —
`/key` then reports `"is_management_key": true`, mirrored into meta).
Paste it through the normal web-UI Settings gear / `set_auth()` path.

### Live-verified API quirks (2026-09-11)

- `time_range.start`/`end` MUST be ISO datetime strings. Numbers and
  epoch-as-string both 400 with `"Invalid ISO datetime"` / `"expected string,
  received number"`.
- A future-dated `end` (next UTC midnight) is accepted; today's partial
  bucket is returned.
- `request_count` values are strings, not numbers.
- Responses carry `cachedAt` (epoch ms) — counts lag by the cache window;
  `metadata.truncated` exists but was `false` at 1-day granularity.

## Free-model request tier (official constants)

From https://openrouter.ai/docs/api-reference/limits (fetched 2026-09-11):
20 requests/minute; 50 requests/day with under $10 lifetime credits purchased;
1000 requests/day at/above $10. Caps are **account-global** (shared across
all keys) and apply **only to `:free` model variants** — paid models are
uncapped and don't count.

The cap is **derived, not reported** by any endpoint:
`total_credits >= 10 => 1000 else 50` using lifetime `total_credits` from
`/credits` (never current balance). When credits data is absent,
`is_free_tier` from `/key` is the fallback (it documents "paid for credits
before" — any amount), else a conservative 50.

## Windows

- `key_limit` — only when the key has a configured `limit > 0`. `used`
  prefers server-reported `limit_remaining`, falls back to the spend within
  the key's `limit_reset` window (`usage_daily`/`usage_weekly`/`usage_monthly`),
  then cumulative `usage`. `resets_at = limit_reset`.
- `rate_limit` — from `key.data.rate_limit` (`{requests, interval}`), added
  only when `requests > 0`. Purely informational: `pct` and `cap` are `None`,
  `used = requests` with `used_is_remaining = True`, `unit = "requests"`,
  label includes the interval (e.g. `"Rate Limit (/10s)"`). No `resets_at` —
  it's a rolling burst ceiling, not a fixed-window quota.

  **Deprecated field (kept anyway, per user direction):** the limits docs
  mark `rate_limit` as "A deprecated object in the response, safe to ignore,"
  and live keys (verified 2026-09-11) return the sentinel
  `{"requests": -1, "interval": "10s", "note": "This field is deprecated and
  safe to ignore."}`. The `requests > 0` guard suppresses the window for the
  sentinel. The field isn't documented as removed, so the window is kept for
  any key that still reports a real positive value.
- `credits` — always added when `total_credits > 0` (pct = usage/total) or
  when only `total_usage` is known (pct = `None`, `used_is_remaining = True`,
  `used` = remaining balance). Label "Balance".
- `free_requests` — today's real request count from the analytics endpoint
  vs the derived tier cap. `used` = summed `request_count` (int), `cap` =
  1000/50 per the tier derivation above, `pct` = used/cap, `unit` =
  "requests", `resets_at` = next UTC midnight (epoch seconds; the runner's
  `to_host_iso` renders it). Emitted **only** when analytics data is usable —
  no fake row on degradation (the web UI renders `used: null` as "—", so a
  cap-less placeholder would be noise). Degradation is visible in meta:
  `free_requests_auth: "degraded"` vs `"management_key"`, plus
  `daily_requests` / `daily_request_cap` for dashboards.

Because `rate_limit`'s `pct` is always `None`, it's automatically excluded
from `headline.py`'s biggest-mover scan and from `sqlite_store.history_row()`
(only windows with a numeric `pct` get historized). `free_requests` has a
numeric `pct` when present, so it **is** historized and headlined like the
USD windows.

## Meta fields (`_openrouter`)

Standard key/credits passthroughs plus: `byok_usage` (all-time BYOK
pass-through spend), `byok_usage_daily/weekly/monthly` (per reset-window),
`is_management_key`, `daily_requests`, `daily_request_cap`,
`free_requests_auth`. Parsed since 2026-09-11; previously `byok_usage*`
existed in the payload but was dropped.

## Management API capability map (verified live 2026-09-11)

Everything the Management key reaches beyond the three wired endpoints.
All read-side probes below ran against the live account; a write-side
exists (key create/update/disable/delete, credit transfers between keys)
but was deliberately not probed.

### `POST /api/v1/analytics/query` — full query grammar

| Axis | Values (probed; anything else 400s "Invalid analytics query request") |
|---|---|
| `metrics` | `request_count` — the **only** valid metric (`usage`, `token_count`, `spend`, `cost` all rejected) |
| `granularity` | `day`, `hour`, `week`, `month` (no `total`); bucket column follows: `date__hour` / `date__day` / `date__week` / `date__month` |
| `dimensions` | `model`, `provider` — alone or combined; with any dimension the day column renames to `created_at__day` |
| `time_range` | `{start, end}` ISO strings (see quirks above) |

Quirks: counts are strings; `cachedAt` (epoch ms) on every response —
counts lag by the cache window; `metadata.truncated` seen `false` at 1-day
scale. The daemon uses only `request_count` + `granularity: "day"` for
`free_requests`. Per-model/per-provider shares are available for future
segments (verified same-day: 104 req → DeepSeek 96, GLM-5.3 6, others 1–2;
by provider: Together/Google/BaseTen/Liquid). No key/endpoint/BYOK
dimension exists.

### `GET /api/v1/keys` — list ALL inference keys

`data` is a **bare list** (not the `{data: {data: []}}` envelope of the
self-`/key` GET): each key carries `label`, `hash`, `name`, `limit`,
`limit_remaining`, `limit_reset`, `usage` + `usage_daily/weekly/monthly`,
`byok_usage*`, `disabled`, `expires_at`, `created_at`, `updated_at`,
`external_user`, `workspace_id`. Use case: per-key limit windows — a
7-key account had a real $1 cap at 57.5% used that the self-`/key` poll
(unlimited management key) can never see.

### `GET /api/v1/activity` — per-model×provider×day feed

Rows: `date`, `model`, `model_permaslug`, `endpoint_id`, `provider_name`,
`requests`, `byok_requests`, `usage` (USD), `byok_usage_inference`,
`prompt_tokens`, `completion_tokens`, `reasoning_tokens`. Caveats:

- **Day-lagged**: completed days only — today never appears (use analytics
  for the in-progress day's request count).
- **`offset` ignored**: always returns the full feed (133 rows = 12 sparse
  days, Aug 17→Sep 10 on the probe date); small accounts need no paging.
- **Daily request sums reconcile exactly** with analytics `request_count`
  where both have data (Sep 6/7/9/10: 158/83/83/337 in both) — the rows are
  real. Spend on `:free`-heavy accounts is tiny but nonzero; format with
  more than 4 decimals or it flattens to $0.0000.
- **Slug join gotcha**: rows use permaslugs (dated, e.g. `…-20260731`) that
  match the catalog's `canonical_slug`, not the undated catalog `id`
  (`deepseek/deepseek-v4-flash`); dated slugs also get superseded
  (`…-vision-exp-20260821` coexists).

### `GET /api/v1/models` — public catalog (auth adds nothing)

Identical 443-model response with or without the key (verified
`authed-only: none`). 19 `:free` variants + 16 `~`-aliases (`alias_target`
resolves them to a different canonical model than the label suggests).
Per-model: `pricing` (per-token strings: `prompt`, `completion`,
`input_cache_read/write`, `web_search`; tiered `overrides` on some paid
models), `architecture` (modality/tokenizer), `top_provider`
(`max_completion_tokens`, moderation), `context_length` (up to 1.05M),
`supported_parameters`, `per_request_limits`, `created`, `description`.
`GET /api/v1/models/{slug}/endpoints` returns 200 with an **always-empty
list** even under a Management key — provider routing is folded into the
model entry itself; provider-level data instead comes from analytics
`dimensions: ["provider"]` and activity's `provider_name`.

**Join recipe for verified per-model spend:** activity `model_permaslug` →
strip date suffix → catalog `canonical_slug` → entry → real `pricing` ⇒
per-model spend computed from token counts × per-token prices, cross-check
against the row's own `usage`.

## Environment / Config

Configured via the daemon's normal `configure()`/`set_auth()` path (stored
in `secrets.sqlite`, kind `"auth"`) — not read from `OPENROUTER_API_KEY` or
other env vars directly (see `sqlite_store.Store.secret_get`/`secret_set`).
Use a Management key (https://openrouter.ai/settings/management-keys) to get
the `free_requests` window; an inference key still powers the other windows.
