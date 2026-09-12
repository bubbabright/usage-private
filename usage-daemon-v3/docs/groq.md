---
summary: "Groq provider (usage-daemon-v3): console spend/usage via the browser session (Stytch), with per-model daily request/token limit gauges."
read_when:
  - Debugging Groq console session, Stytch refresh, or cookie behavior
  - Updating Groq windows, daily limits, or the activity-API window
  - Explaining Groq provider behavior in this daemon
---

# Groq Provider

Implementation: `usage_daemon/providers/groq.py`.
Tests: `tests/test_providers_groq.py`.

Reads real usage from the console platform activity API through the user's
browser session (replaces the old fake-chat-completions rate-limit-header
probe, which wasted quota and only described throttles).

## Auth flow (Stytch B2B, browser cookies)

Session comes from Firefox cookies for `groq.com`:

1. **`stytch_session` (preferred)** — long-lived (~30 day) opaque token.
   Exchanged for a fresh short-lived JWT on every fetch via Stytch's B2B
   frontend SDK endpoint, the same call the console SPA makes:
   `POST https://api.stytchb2b.groq.com/sdk/v1/b2b/sessions/authenticate`
   with `Authorization: Basic base64(<publicToken>:<sessionToken>)`,
   `X-SDK-Client` (base64 Stytch SDK telemetry blob), `X-SDK-Parent-Host:
   console.groq.com`, `Origin: https://console.groq.com`, and JSON body
   `{"session_token": ..., "session_duration_minutes": 30}`. The response's
   `data.session_jwt` (fallback shape `session.jwt`) is the fresh JWT.
2. **`stytch_session_jwt` (fallback)** — short-lived JWT used directly when
   no opaque session exists or the exchange fails.

The organization id comes from the JWT's `https://groq.com/organization`
claim (no signature verification — the API authenticates the token, this
only reads the routing claim).

### Stytch public token

`DEFAULT_STYTCH_PUBLIC_TOKEN` is Groq's **publishable** console token
(`public-token-live-…`, embedded in the console bundle — public by design,
it only authorizes SDK calls from console.groq.com's origin). Overridable
without code changes:

- env: `GROQ_STYTCH_PUBLIC_TOKEN`, `GROQ_STYTCH_URL`
- config keys: `stytch_public_token`, `stytch_url`

History: the first implementation hardcoded `stytch_live_637662822`, which
Stytch rejects with `400 invalid_public_token_id` ("public_token_id format
is invalid") before any session validation — the opaque-session fallback
could never succeed with it. Verified live 2026-09-11; replaced with the
value from Groq's own console bundle (also confirmed in CodexBar's
`GroqConsoleStytch.swift`).

An earlier version preferred the `stytch_session_jwt` cookie directly; that
is wrong — the JWT expires in minutes and is only refreshed while a console
tab is open, so the exchange of the long-lived opaque token must be tried
first (matches CodexBar's `GroqConsoleSession.resolveJWT` order).

## Data source

`GET https://api.groq.com/platform/v1/organizations/{orgId}/activity`
with `Authorization: Bearer <fresh jwt>`, `groq-organization: <orgId>`, and
`start_date`/`end_date` as unix seconds covering **the last 30 days**
(`ACTIVITY_HISTORY_DAYS = 30`): start of the UTC day 29 days ago through
the end of the current UTC day. Rows are per-model, per-day records
(`timestamp` = the UTC day, `num_requests`, `n_context_tokens_total`,
`n_non_cached_context_tokens_total`, `n_generated_tokens_total`, `cost`).
401/403 → `AuthExpiredError`, 429 → `RateLimitedError` (Retry-After).

## Windows

Monthly aggregate (labeled "(30d)", `resets_at` null — they are sliding
totals that never reset at midnight, so no countdown is shown):

- `cost` — sum of row costs, USD.
- `generated_tokens` — sum of `n_generated_tokens_total`.
- `context_tokens` — sum of `n_context_tokens_total`.
- `requests` — sum of `num_requests`.

Daily per-model gauges (resets at next UTC midnight), emitted only for
models with a known cap and only when the model was used **today**:

- `daily_<model>` — today's requests vs the per-day request cap (RPD).
- `daily_tokens_<model>` — today's rate-limit tokens vs the per-day token
  cap (TPD). Cached tokens don't count toward Groq rate limits, so this
  sums `n_non_cached_context_tokens_total + n_generated_tokens_total` only.

### Daily limits (console.groq.com/docs/rate-limits, 2026-09)

Requests/day (RPD): `llama-3.1-8b-instant` 14,400 (legacy listing);
`whisper-large-v3(-turbo)` and `distil-whisper-large-v3` 2,000;
`openai/gpt-oss-*` and `qwen/qwen3.x-27b` 1,000;
`meta-llama/llama-prompt-guard-2-*` 14,400; `groq/compound(-mini)` 250;
`canopylabs/orpheus-*` 100.
Tokens/day (TPD): gpt-oss/qwen 200K; prompt-guard and
`llama-3.1-8b-instant` 500K; orpheus 3.6K; whisper models are audio-only
(no token cap).

Both tables are operator-overridable: `configure()` accepts
`model_limits` (RPD) and `model_token_limits` (TPD) dicts that merge over
the defaults; `config()` reports the merged tables.

## Verified quirks (2026-09-11)

- A 30-day query returns one row per (model, UTC day) with activity;
  multiple rows per day can appear (one per API key/project).
- The in-progress day's row is timestamped at that day's 00:00 UTC.
- Zero-usage-but-valid responses (no rows) raise `ProviderError`, **not**
  `AuthExpiredError` — a healthy but idle session must not trigger the
  Firefox cookie self-heal or show "re-auth needed".
- Empty-window guard: if even the daily gauges come out empty, `parse()`
  raises `ProviderError("no usable Groq activity data")`.

## Config

`cookie_from_firefox = "groq.com"` in `config.toml` (plus `team`-less —
no team id needed). Optional `stytch_public_token` / `stytch_url` /
`model_limits` / `model_token_limits` keys. `set_auth()` exists for
interface parity but the API key it stores is unused by this provider.
