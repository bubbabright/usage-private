---
summary: "Context7 provider (usage-daemon-v3): monthly request quota from the dashboard stats API, with automatic Clerk session-JWT refresh."
read_when:
  - Debugging Context7 auth_expired despite a fresh Firefox cookie
  - Updating the Context7 Clerk refresh flow or stats parsing
  - Explaining Context7 provider behavior in this daemon
---

# Context7 Provider

Implementation: `usage_daemon/providers/context7.py`.
Tests: `tests/test_providers_context7.py` (fixture: `context7-stats.json`).

## Data source

`GET https://context7.com/api/dashboard/stats/<teamId>`
→ `{"success": true, "data": {"quotaLimit", "userRequests", "ownerPlan",
"creditBalance", "dailyStats": [...]}}` — the monthly request quota
(`quotaLimit`) vs requests consumed this cycle (`userRequests`). No
reset-date field in the payload, so the window's `resets_at` is null.
`team_id` comes from `config.toml` (`[providers.context7] team_id = …`).

## Auth: Clerk session refresh (required)

Context7's dashboard authenticates with **Clerk**. Clerk issues its
`__session` JWT with only a **~60-second** lifetime and re-issues it while
the dashboard tab is open. A cookie pulled from Firefox on a poll schedule
(300s interval) is therefore almost always expired, and the stats API
answers `401 {"error":"Unauthorized"}` even though the Clerk session
itself is still active for days (`expire_at` ~1 week out).

So `fetch()` mints a fresh session JWT before every stats call — the same
call Clerk's JS SDK makes at page load:

1. Read the `__session` cookie from the Firefox cookie header and decode
   its JWT payload to get the session id (`sid` claim, `sess_…`).
2. `POST https://clerk.context7.com/v1/client/sessions/<sid>/tokens`
   with the browser's Clerk cookies, `Origin: https://context7.com`,
   `Referer: https://context7.com/dashboard`, empty JSON body.
   → `{"object": "token", "jwt": "<fresh ~60s session JWT>"}`.
3. Call the stats API with `Authorization: Bearer <jwt>` (also verified to
   work as `Cookie: __session=<jwt>`).

Notes verified live 2026-09-11/12:

- The `tokens` endpoint accepts an **expired** `__session` as long as the
  Clerk session is active — rotation is the whole point.
- The publishable key (`pk_live_…`) is **not** required for this call;
  sending `Authorization` together with `Origin` is rejected by Clerk
  ("only one of the 'Origin' and 'Authorization' headers should be
  provided"), so the request is browser-shaped: cookies + Origin only.
- The `sid` is stable across JWT rotations; the JWT in the cookie store may
  be hours old and still refresh fine.

## Failure semantics

- No `__session` cookie in the configured/pulled header, no `sid` in the
  JWT, or a non-200 token response → `AuthExpiredError` prompting the user
  to log in at context7.com and refresh the cookie.
- Stats API 401/403 after a successful refresh → `AuthExpiredError`
  ("session logged out") — the Clerk session itself was revoked.
- Envelope `success != true` or missing `userRequests` → `AuthExpiredError`
  (kept from the JS port; with the refresh step this now only fires when
  the session is logged out mid-flight).

## Windows

Single window `requests` ("Requests/mo"): `used` = **remaining** requests
(`quotaLimit - userRequests`, `used_is_remaining: true`), `cap` =
`quotaLimit`, `pct` = consumed fraction, `unit = "requests"`, `resets_at`
null. `meta()` carries `quota_limit`, `user_requests`, `owner_plan`,
`credit_balance` for dashboards.

## Config

```toml
[providers.context7]
team_id = "<uuid from the dashboard stats URL>"
cookie_from_firefox = "context7.com"
```
