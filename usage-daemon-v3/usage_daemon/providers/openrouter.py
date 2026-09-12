"""OpenRouter usage provider plugin (port of src/providers/openrouter.js).

Polls read-only account-metadata endpoints every ~5 min (no completions
traffic, so this never touches OpenRouter's request-based rate-limit tiers):
GET /api/v1/key (spending cap/usage/rate_limit), GET /api/v1/credits
(lifetime purchased/spent), and — when the configured key is a Management
key (openrouter.ai/settings/management-keys) — POST /api/v1/analytics/query
for today's real request count. All three accept the same bearer key; a
plain inference key still works but 403s on analytics (degrades to no
free-requests window, never fails the poll).

`key.data.rate_limit` ({requests, interval}) is surfaced as its own
informational `windows` entry (no pct/cap — see RATE_LIMIT_COLOR below)
whenever `requests > 0`. As of 2026-09, OpenRouter documents this field as
"A deprecated object in the response, safe to ignore" and sends a
`requests: -1` sentinel on live keys; that guard suppresses the window for
those, but the field is kept rather than removed outright — see
docs/openrouter.md.

Free-model request tier (official constants: 20 req/min; 50 req/day under
$10 lifetime credits, 1000 req/day at/above): the cap is DERIVED —
total_credits >= 10 => 1000 else 50, falling back to is_free_tier when
credits data is absent (is_free_tier documents "paid for credits before",
any amount). The used count comes from /analytics/query (request_count,
today's UTC bucket). Both ride the `free_requests` window; cap alone is
also mirrored into meta as daily_request_cap. Limits are account-global
and apply only to `:free` model variants — paid models are uncapped.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
from typing import Any

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

LIMIT_COLOR = "#56B4E9"
CREDITS_COLOR = "#E69F00"
RATE_LIMIT_COLOR = "#009E73"
FREE_REQUESTS_COLOR = "#CC79A7"  # Okabe-Ito reddish purple

ID = "openrouter"
LABEL = "OpenRouter"

KEY_URL = "https://openrouter.ai/api/v1/key"
CREDITS_URL = "https://openrouter.ai/api/v1/credits"
ANALYTICS_URL = "https://openrouter.ai/api/v1/analytics/query"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) usage-daemon/0.1"

# Official free-model tier constants (openrouter.ai/docs/api-reference/limits):
# rpm applies to both tiers; rpd keys off LIFETIME credits purchased, not
# current balance. total_credits comes from /api/v1/credits.
FREE_MODEL_CREDITS_THRESHOLD = 10.0
FREE_MODEL_RPD_WITH_CREDITS = 1000
FREE_MODEL_RPD_NO_CREDITS = 50


def _clamp_pct(n):
    """Clamp a finite 0..100 percentage; None-safe (bools/non-numbers pass through as None)."""
    if not isinstance(n, (int, float)) or isinstance(n, bool) or not math.isfinite(n):
        return None
    return max(0.0, min(100.0, float(n)))


def _num(v):
    """True for finite real numbers only — bools and NaN/inf are rejected (API sends counts as strings)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _as_num(v) -> float | None:
    """Coerce to float when finite, else None — the single funnel for every numeric field in parse()."""
    return float(v) if _num(v) else None


def _usage_for_reset(key_data: dict) -> float | None:
    """Usage matching the key's limit_reset window: daily/weekly/monthly -> usage_daily/_weekly/_monthly."""
    reset = key_data.get("limit_reset")
    if not isinstance(reset, str) or not reset:
        return None
    field = {
        "daily": "usage_daily",
        "weekly": "usage_weekly",
        "monthly": "usage_monthly",
    }.get(reset.lower())
    return _as_num(key_data.get(field)) if field else None


def _free_requests_cap(total_credits: float | None, is_free_tier: bool | None) -> int:
    """Derive the account-global free-variant daily request cap.

    Official rule keys off credits purchased ALL TIME (>= $10 => 1000/day,
    else 50/day), so use lifetime total_credits — never current balance.
    is_free_tier ("paid for credits before", any amount) is the fallback
    signal when credits data is missing from the envelope.
    """
    if total_credits is not None:
        return FREE_MODEL_RPD_WITH_CREDITS if total_credits >= FREE_MODEL_CREDITS_THRESHOLD else FREE_MODEL_RPD_NO_CREDITS
    if is_free_tier is False:
        return FREE_MODEL_RPD_WITH_CREDITS  # paid at some point; amount unknown
    return FREE_MODEL_RPD_NO_CREDITS


def _utc_day_bounds_epoch(now: _dt.datetime | None = None) -> tuple[int, int]:
    """(start, end) epoch-seconds of the current UTC day — the analytics
    time_range. end is the next midnight so the in-progress bucket is covered
    (the API accepted a future end in testing; it clamps to now)."""
    now = now or _dt.datetime.now(_dt.timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + _dt.timedelta(days=1)
    return int(start.timestamp()), int(end.timestamp())


def _utc_day_bounds_iso(now: _dt.datetime | None = None) -> tuple[str, str]:
    """(start, end) of the current UTC day as ISO strings for the analytics
    time_range. The API REJECTS numbers and epoch-as-string with 400
    "Invalid ISO datetime" (verified 2026-09-11); ISO strings are required.
    end is next midnight so the in-progress day bucket is fully covered."""
    s, e = _utc_day_bounds_epoch(now)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    return (
        _dt.datetime.fromtimestamp(s, _dt.timezone.utc).strftime(fmt),
        _dt.datetime.fromtimestamp(e, _dt.timezone.utc).strftime(fmt),
    )


def _requests_from_analytics(payload) -> float | None:
    """Sum request_count across rows of a /analytics/query response.

    Live endpoint quirk (verified 2026-09-11): request_count arrives as a
    STRING ("84"), so coerce. Rows keyed by `date__day` when granularity=day.
    Returns None when the payload has no usable rows (caller degrades)."""
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            return None
    if not isinstance(payload, dict):
        return None
    data = payload.get("data")
    if isinstance(data, dict):
        data = data.get("data")
    if not isinstance(data, list):
        return None
    total = 0.0
    seen = False
    for row in data:
        if not isinstance(row, dict):
            continue
        n = row.get("request_count")
        if isinstance(n, str) and n.strip().isdigit():
            n = float(n)
        if _num(n):
            total += float(n)
            seen = True
    return total if seen else None


def parse(raw) -> dict:
    """Pure function of a combined envelope string — no network/fs, unit-tests against fixtures.

    Envelope (assembled by fetch()): {"key": <GET /api/v1/key text|null>,
    "credits": <GET /api/v1/credits text|null>, "analytics": <POST
    /analytics/query text|null>}. Sub-payloads may be JSON text or dicts and
    are parsed independently — any one 403ing/missing just omits its windows
    (management-key degrade), while an unparseable envelope raises
    AuthExpiredError. Emits windows: key spend (pct/cap + rolling usage keyed
    to limit_reset), rate_limit (informational, sentinel-guarded), and
    free_requests (analytics used count vs derived daily cap); everything
    else lands in meta under _openrouter (see docs/openrouter.md).
    """
    try:
        envelope = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable openrouter envelope")
    if not isinstance(envelope, dict):
        raise AuthExpiredError("unparseable openrouter envelope")

    windows = []
    tier = None
    key_stats = None
    credits_stats = None

    key_data = None
    if envelope.get("key"):
        try:
            parsed = json.loads(envelope["key"]) if isinstance(envelope["key"], str) else envelope["key"]
        except Exception:
            parsed = None
        if isinstance(parsed, dict) and isinstance(parsed.get("data"), dict):
            key_data = parsed["data"]
    if isinstance(key_data, dict):
        if key_data.get("is_free_tier") is True:
            tier = "free"
        elif key_data.get("is_free_tier") is False:
            tier = "paid"

        limit_value = _as_num(key_data.get("limit"))
        usage_value = _as_num(key_data.get("usage"))
        remaining_value = _as_num(key_data.get("limit_remaining"))
        reset_window = key_data.get("limit_reset") if isinstance(key_data.get("limit_reset"), str) else None
        reset_usage_value = _usage_for_reset(key_data)
        key_stats = {
            "limit": limit_value,
            "usage": usage_value,
            "limit_remaining": remaining_value,
            "limit_reset": reset_window,
            "usage_daily": _as_num(key_data.get("usage_daily")),
            "usage_weekly": _as_num(key_data.get("usage_weekly")),
            "usage_monthly": _as_num(key_data.get("usage_monthly")),
            "rate_limit": key_data.get("rate_limit") if isinstance(key_data.get("rate_limit"), dict) else None,
        }
        if limit_value is not None and limit_value > 0:
            used_amount = None
            if remaining_value is not None:
                used_amount = max(0.0, limit_value - max(0.0, remaining_value))
            elif reset_usage_value is not None:
                used_amount = reset_usage_value
            elif usage_value is not None:
                used_amount = usage_value
            if used_amount is not None:
                windows.append({
                    "id": "key_limit",
                    "label": "Key",
                    "letter": "Ky",
                    "pct": _clamp_pct((100 * used_amount) / limit_value),
                    "used": used_amount,
                    "cap": limit_value,
                    "unit": "USD",
                    "resets_at": reset_window,
                    "color": LIMIT_COLOR,
                    "will_deplete": False,
                })

        rate_limit = key_stats.get("rate_limit")
        if isinstance(rate_limit, dict):
            rl_requests = _as_num(rate_limit.get("requests"))
            rl_interval = rate_limit.get("interval") if isinstance(rate_limit.get("interval"), str) else None
            if rl_requests is not None and rl_requests > 0:
                windows.append({
                    "id": "rate_limit",
                    "label": f"Rate Limit (/{rl_interval})" if rl_interval else "Rate Limit",
                    "letter": "RL",
                    "pct": None,
                    "used": rl_requests,
                    "used_is_remaining": True,
                    "cap": None,
                    "unit": "requests",
                    "note": (
                        f"Burst capacity: {rl_requests:g} requests per {rl_interval}"
                        if rl_interval else "Burst capacity from OpenRouter's rate_limit field"
                    ),
                    "resets_at": None,
                    "color": RATE_LIMIT_COLOR,
                    "will_deplete": False,
                })

    credits_data = None
    if envelope.get("credits"):
        try:
            parsed = json.loads(envelope["credits"]) if isinstance(envelope["credits"], str) else envelope["credits"]
        except Exception:
            parsed = None
        if isinstance(parsed, dict) and isinstance(parsed.get("data"), dict):
            credits_data = parsed["data"]
    if isinstance(credits_data, dict):
        total = credits_data.get("total_credits")
        used = credits_data.get("total_usage")
        total_value = _as_num(total)
        used_value = _as_num(used)
        credits_stats = {
            "total_credits": total_value,
            "total_usage": used_value,
            "balance": round(((total_value if total_value is not None else 0) - (used_value if used_value is not None else 0)) * 100) / 100 if used_value is not None else None,
        }
        if total_value is not None and total_value > 0 and used_value is not None:
            windows.append({
                "id": "credits",
                "label": "Balance",
                "letter": "Bal",
                "pct": _clamp_pct((100 * used_value) / total_value),
                "used": used_value,
                "cap": total_value,
                "unit": "USD",
                "resets_at": None,
                "color": CREDITS_COLOR,
                "will_deplete": False,
            })
        elif used_value is not None:
            balance = round(((total_value if total_value is not None else 0) - used_value) * 100) / 100
            windows.append({
                "id": "credits",
                "label": "Balance",
                "letter": "Bal",
                "pct": None,
                "used": balance,
                "cap": None,
                "unit": "USD",
                "used_is_remaining": True,
                "resets_at": None,
                "color": CREDITS_COLOR,
                "will_deplete": False,
            })

    # --- free-variant daily request tier (Management-key analytics) ---
    # used: sum of today's UTC request_count buckets; cap: derived from
    # lifetime credits (>= $10 => 1000 else 50). Degrades quietly — a None
    # `used` is not rendered by the web UI, so no window row is emitted and
    # the reason lands in meta (free_requests_auth) instead of faking a row.
    requests_value = _requests_from_analytics(envelope.get("analytics"))
    if requests_value is not None:
        cap = _free_requests_cap(
            credits_stats.get("total_credits") if credits_stats else None,
            tier == "free" if tier else None,
        )
        resets_at = _utc_day_bounds_epoch()[1]  # next UTC midnight (epoch s)
        windows.append({
            "id": "free_requests",
            "label": "Free Requests",
            "letter": "FR",
            "pct": _clamp_pct((100 * requests_value) / cap) if cap else None,
            "used": int(requests_value),
            "cap": cap,
            "unit": "requests",
            "resets_at": resets_at,
            "color": FREE_REQUESTS_COLOR,
            "will_deplete": False,
        })

    if not windows:
        raise RuntimeError("OpenRouter returned no usable meter (no key limit, no credits data)")

    # `key` was already parsed into key_data above; reuse it to reach fields
    # that didn't feed windows (byok_usage*, management-key flag).
    key_data_meta = key_data if isinstance(key_data, dict) else None

    return {
        "tier": tier,
        "windows": windows,
        "segments": [],
        "_openrouter": {
            **(key_stats or {}),
            **(credits_stats or {}),
            # BYOK pass-through spend (present but zero on most accounts;
            # byok_usage is all-time, the rest are per reset-window).
            "byok_usage": _as_num(key_data_meta.get("byok_usage")) if key_data_meta else None,
            "byok_usage_daily": _as_num(key_data_meta.get("byok_usage_daily")) if key_data_meta else None,
            "byok_usage_weekly": _as_num(key_data_meta.get("byok_usage_weekly")) if key_data_meta else None,
            "byok_usage_monthly": _as_num(key_data_meta.get("byok_usage_monthly")) if key_data_meta else None,
            "is_management_key": bool(key_data_meta.get("is_management_key")) if key_data_meta else None,
            "daily_requests": int(requests_value) if requests_value is not None else None,
            "daily_request_cap": _free_requests_cap(
                credits_stats.get("total_credits") if credits_stats else None,
                tier == "free" if tier else None,
            ) if (credits_stats or tier is not None) else None,
            # Auth-degraded signal: analytics unreadable (plain inference key
            # => 403 on Management endpoints). Free-requests window absent.
            "free_requests_auth": "management_key" if requests_value is not None else "degraded",
        },
    }


def create() -> dict:
    state: dict[str, Any] = {"api_key": None, "last_stats": None}

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://openrouter.ai/activity",
            "auth": {"kind": "token"},
            "windows": [
                {"id": "key_limit", "label": "Key", "color": LIMIT_COLOR},
                {"id": "rate_limit", "label": "Rate Limit", "color": RATE_LIMIT_COLOR},
                {"id": "credits", "label": "Balance", "color": CREDITS_COLOR},
                {"id": "free_requests", "label": "Free Requests", "color": FREE_REQUESTS_COLOR},
            ],
            "tiers": ["free", "paid"],
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        if "api_key" in cfg:
            state["api_key"] = str(cfg["api_key"]).strip() if cfg["api_key"] else None
        if "apiKey" in cfg:
            state["api_key"] = str(cfg["apiKey"]).strip() if cfg["apiKey"] else None

    async def set_auth(payload: str) -> None:
        state["api_key"] = str(payload or "").strip() or None

    async def fetch() -> str:
        if not state["api_key"]:
            raise AuthExpiredError("no OpenRouter API key configured")

        async def get(url: str):
            return await c.get(
                url,
                headers={
                    "Authorization": f"Bearer {state['api_key']}",
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                },
            )

        async def analytics_today():
            """POST /analytics/query for today's UTC request_count.

            Best-effort: a Management key is required (plain inference keys
            get 403/401). Any failure here yields None and the free-requests
            window is simply omitted this cycle — never fails the poll."""
            try:
                start, end = _utc_day_bounds_iso()
                res = await c.post(
                    ANALYTICS_URL,
                    headers={
                        "Authorization": f"Bearer {state['api_key']}",
                        "User-Agent": USER_AGENT,
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                    },
                    json={
                        "metrics": ["request_count"],
                        "granularity": "day",
                        "time_range": {"start": start, "end": end},
                    },
                )
                if res.status_code < 400:
                    return res.text
                if res.status_code == 429:
                    ra = res.headers.get("retry-after")
                    rate_limited_val = int(ra) if ra and ra.isdigit() else None
                    if rate_limited_val is not None:
                        state["analytics_rate_limited"] = rate_limited_val
                return None
            except Exception:
                return None

        key = None
        credits = None
        analytics = None
        rate_limited = None
        key_denied = False
        credits_denied = False

        c = create_client()
        try:
            try:
                key_res = await get(KEY_URL)
                if key_res.status_code in (401, 403):
                    key_denied = True
                elif key_res.status_code == 429:
                    ra = key_res.headers.get("retry-after")
                    rate_limited = int(ra) if ra and ra.isdigit() else None
                elif key_res.status_code < 400:
                    key = key_res.text
            except Exception:
                pass

            try:
                credits_res = await get(CREDITS_URL)
                if credits_res.status_code in (401, 403):
                    credits_denied = True
                elif credits_res.status_code == 429:
                    ra = credits_res.headers.get("retry-after")
                    rate_limited = rate_limited if rate_limited is not None else (int(ra) if ra and ra.isdigit() else None)
                elif credits_res.status_code < 400:
                    credits = credits_res.text
            except Exception:
                pass

            analytics = await analytics_today()
        finally:
            await c.aclose()

        if not key and not credits:
            if rate_limited is not None:
                raise RateLimitedError(rate_limited)
            if key_denied and credits_denied:
                raise AuthExpiredError("OpenRouter rejected this key on both /key and /credits")
            raise RuntimeError("openrouter.ai returned no usable body")

        raw = json.dumps({"key": key, "credits": credits, "analytics": analytics})
        state["last_stats"] = parse(raw).get("_openrouter") or {}
        return raw

    def meta() -> dict:
        return state.get("last_stats") or {}

    return {
        "id": ID,
        "label": LABEL,
        "auth": {"kind": "token"},
        "config": config,
        "configure": configure,
        "set_auth": set_auth,
        "fetch": fetch,
        "interval_seconds": lambda: 300,
        "meta": meta,
        "parse": parse,
    }
