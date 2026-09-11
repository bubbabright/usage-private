"""Groq usage provider plugin (console session + activity API).

Authenticates through the user's Firefox session (stytch_session_jwt or
stytch_session) and reads real usage metrics from the Groq platform
activity API. Replaces the old approach of making fake chat completions
to read rate-limit headers.

Auth flow:
  1. Read stytch_session_jwt from Firefox cookies (direct JWT use).
  2. Fallback: read stytch_session (opaque token), exchange via
     Stytch B2B SDK (POST /sdk/v1/b2b/sessions/authenticate) for a
     fresh JWT and org_id extracted from the JWT claim.

Endpoints:
  - GET https://api.groq.com/platform/v1/organizations/{orgId}/activity
    Returns per-model, per-day usage: cost, tokens, requests.
  - Stytch exchange: https://api.stytchb2b.groq.com/sdk/v1/b2b/sessions/authenticate

Known free-tier daily request limits (configurable via model_limits):
  - llama-3.1-8b-instant: 14,400/day
  - whisper-large-v3: 1,000/day
  - distil-whisper-large-v3: 1,000/day

Configurable via GROQ_STYTCH_PUBLIC_TOKEN / GROQ_STYTCH_URL env vars
to override the built-in Stytch credentials.
"""

from __future__ import annotations

import base64
import datetime as _dt
import json
import math
from typing import Any

import httpx

from ..cookiejar import cookie_header_for
from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

COST_COLOR = "#D55E00"
TOKENS_COLOR = "#0072B2"
REQUESTS_COLOR = "#CC79A7"
DAILY_LIMIT_COLOR = "#000000"

GROQ_FREE_TIER_MODEL_LIMITS = {
    "llama-3.1-8b-instant": 14400,
    "whisper-large-v3": 1000,
    "distil-whisper-large-v3": 1000,
}

ID = "groq"
LABEL = "Groq"

DEFAULT_STYTCH_PUBLIC_TOKEN = "stytch_live_637662822"
DEFAULT_STYTCH_URL = "https://api.stytchb2b.groq.com"
ACTIVITY_URL = "https://api.groq.com/platform/v1"
USER_AGENT = "usage-daemon/0.1"


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _as_num(v) -> float | None:
    return float(v) if _num(v) else None


def _org_id_from_jwt(jwt: str) -> str | None:
    try:
        parts = jwt.split(".")
        if len(parts) != 3:
            return None
        payload = parts[1]
        padding = 4 - len(payload) % 4
        if padding != 4:
            payload += "=" * padding
        decoded = base64.urlsafe_b64decode(payload)
        claims = json.loads(decoded)
        org_claim = claims.get("https://groq.com/organization")
        if isinstance(org_claim, dict):
            return org_claim.get("id")
        return org_claim if isinstance(org_claim, str) else None
    except Exception:
        return None


async def _exchange_stytch_session(session_token: str, public_token: str, stytch_url: str, client: httpx.AsyncClient) -> tuple[str, str] | None:
    """Exchange opaque stytch_session for fresh JWT and org_id."""
    auth_header = base64.b64encode(f"{public_token}:{session_token}".encode()).decode()

    headers = {
        "Authorization": f"Basic {auth_header}",
        "X-SDK-Client": "next-sdk",
        "X-SDK-Parent-Host": "console.groq.com",
        "Origin": "https://console.groq.com",
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    }

    try:
        res = await client.post(
            f"{stytch_url}/sdk/v1/b2b/sessions/authenticate",
            headers=headers,
        )
        if res.status_code != 200:
            return None
        data = res.json()
        session_jwt = data.get("session", {}).get("jwt")
        if not session_jwt:
            return None
        org_id = _org_id_from_jwt(session_jwt)
        if not org_id:
            return None
        return session_jwt, org_id
    except Exception:
        return None


def _aggregate_activity_data(entries: list[dict]) -> dict:
    """Aggregate activity entries into daily buckets for the last 7 days."""
    now = _dt.datetime.now(_dt.timezone.utc)
    end_ts = int(now.timestamp())
    start_ts = end_ts - (7 * 24 * 3600)

    model_stats: dict[str, dict] = {}

    for entry in entries:
        ts = entry.get("timestamp")
        if not _num(ts):
            continue
        ts = int(ts)

        if ts < start_ts:
            continue

        model = entry.get("model") or "unknown"
        if model not in model_stats:
            model_stats[model] = {
                "context_tokens": 0,
                "non_cached_tokens": 0,
                "generated_tokens": 0,
                "requests": 0,
                "cost": 0.0,
            }
        model_stats[model]["context_tokens"] += _as_num(entry.get("n_context_tokens_total")) or 0
        model_stats[model]["non_cached_tokens"] += _as_num(entry.get("n_non_cached_context_tokens_total")) or 0
        model_stats[model]["generated_tokens"] += _as_num(entry.get("n_generated_tokens_total")) or 0
        model_stats[model]["requests"] += _as_num(entry.get("num_requests")) or 0
        model_stats[model]["cost"] += _as_num(entry.get("cost")) or 0.0

    return {
        "model_stats": model_stats,
    }


def _daily_limit_windows(model_stats: dict, model_limits: dict) -> list[dict]:
    """Build daily request limit windows for models with known limits."""
    windows = []
    for model, stats in model_stats.items():
        limit = model_limits.get(model)
        if not limit:
            continue
        reqs = int(stats.get("requests", 0))
        if reqs <= 0:
            continue
        pct = (100.0 * reqs) / limit
        windows.append({
            "id": f"daily_{model.replace('/', '_').replace('-', '_')}",
            "label": f"{model} daily",
            "letter": "D",
            "pct": max(0.0, min(100.0, pct)),
            "used": reqs,
            "cap": limit,
            "unit": "calls",
            "resets_at": _start_of_next_day(),
            "color": DAILY_LIMIT_COLOR,
            "will_deplete": False,
        })
    return windows


def _daily_limit_windows_from_data(data: dict, model_limits: dict) -> list[dict]:
    """Build daily limit windows from raw activity data."""
    entries = data.get("data", []) if isinstance(data, dict) else []
    if not isinstance(entries, list):
        entries = []
    agg = _aggregate_activity_data(entries)
    return _daily_limit_windows(agg.get("model_stats", {}), model_limits)


def _total_cost(data: dict) -> float:
    return sum(m.get("cost", 0) for m in data.get("model_stats", {}).values())


def _total_generated_tokens(data: dict) -> int:
    total = 0
    for m in data.get("model_stats", {}).values():
        total += int(m.get("generated_tokens", 0))
    return total


def _total_context_tokens(data: dict) -> int:
    total = 0
    for m in data.get("model_stats", {}).values():
        total += int(m.get("non_cached_tokens", 0))
    return total


def _total_requests(data: dict) -> int:
    total = 0
    for m in data.get("model_stats", {}).values():
        total += int(m.get("requests", 0))
    return total


def _start_of_next_day() -> str:
    now = _dt.datetime.now(_dt.timezone.utc)
    next_day = now + _dt.timedelta(days=1)
    reset_time = _dt.datetime(next_day.year, next_day.month, next_day.day, tzinfo=_dt.timezone.utc)
    return reset_time.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse(raw) -> dict:
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable Groq response")

    entries = data.get("data", []) if isinstance(data, dict) else []
    if not isinstance(entries, list):
        entries = []

    agg = _aggregate_activity_data(entries)
    model_limits = data.get("_groq_model_limits") or {}

    total_cost = _total_cost(agg)
    total_tokens = _total_generated_tokens(agg)
    total_context = _total_context_tokens(agg)
    total_reqs = _total_requests(agg)

    windows = []

    if total_cost > 0:
        windows.append({
            "id": "cost",
            "label": "Cost",
            "letter": "$",
            "pct": None,
            "used": total_cost,
            "cap": None,
            "unit": "USD",
            "resets_at": _start_of_next_day(),
            "color": COST_COLOR,
            "will_deplete": False,
        })

    if total_tokens > 0:
        windows.append({
            "id": "generated_tokens",
            "label": "Tokens",
            "letter": "Tk",
            "pct": None,
            "used": total_tokens,
            "cap": None,
            "unit": "tokens",
            "resets_at": _start_of_next_day(),
            "color": TOKENS_COLOR,
            "will_deplete": False,
        })

    if total_context > 0:
        windows.append({
            "id": "context_tokens",
            "label": "Context",
            "letter": "Ctx",
            "pct": None,
            "used": total_context,
            "cap": None,
            "unit": "tokens",
            "resets_at": _start_of_next_day(),
            "color": TOKENS_COLOR,
            "will_deplete": False,
        })

    if total_reqs > 0:
        windows.append({
            "id": "requests",
            "label": "Requests",
            "letter": "Req",
            "pct": None,
            "used": total_reqs,
            "cap": None,
            "unit": "calls",
            "resets_at": _start_of_next_day(),
            "color": REQUESTS_COLOR,
            "will_deplete": False,
        })

    for w in _daily_limit_windows(agg.get("model_stats", {}), model_limits):
        windows.append(w)

    if not windows:
        raise AuthExpiredError("no usable Groq activity data")

    segments = []
    for model, stats in agg.get("model_stats", {}).items():
        model_cost = stats.get("cost", 0)
        if _num(model_cost) and total_cost > 0:
            pct = (100.0 * model_cost) / total_cost
            segments.append({
                "label": model,
                "value": model_cost,
                "pct": pct,
                "color": None,
            })

    result = {
        "tier": None,
        "windows": windows,
        "segments": segments,
        "_groq": {
            "total_cost": total_cost,
            "total_tokens": total_tokens,
            "total_context": total_context,
            "total_requests": total_reqs,
            "models": list(agg.get("model_stats", {}).keys()),
        },
    }
    return result


def create() -> dict:
    state: dict[str, Any] = {
        "stytch_public_token": DEFAULT_STYTCH_PUBLIC_TOKEN,
        "stytch_url": DEFAULT_STYTCH_URL,
        "model_limits": {},
    }

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://console.groq.com/usage",
            "auth": {"kind": "cookie"},
            "windows": [
                {"id": "cost", "label": "Cost", "color": COST_COLOR},
                {"id": "generated_tokens", "label": "Tokens", "color": TOKENS_COLOR},
                {"id": "context_tokens", "label": "Context", "color": TOKENS_COLOR},
                {"id": "requests", "label": "Requests", "color": REQUESTS_COLOR},
            ],
            "tiers": [],
            "model_limits": {**GROQ_FREE_TIER_MODEL_LIMITS, **state.get("model_limits", {})},
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        if "api_key" in cfg:
            state["api_key"] = str(cfg["api_key"]).strip() if cfg["api_key"] else None
        if "model" in cfg:
            state["model"] = str(cfg["model"]).strip() if cfg["model"] else None
        if "cookie" in cfg:
            state["cookie"] = str(cfg["cookie"]).strip() if cfg["cookie"] else None
        if "stytch_public_token" in cfg:
            state["stytch_public_token"] = str(cfg["stytch_public_token"]).strip() if cfg["stytch_public_token"] else None
        if "stytch_url" in cfg:
            state["stytch_url"] = str(cfg["stytch_url"]).strip() if cfg["stytch_url"] else None
        if "model_limits" in cfg and isinstance(cfg["model_limits"], dict):
            # Merge custom model limits with defaults
            state.setdefault("model_limits", {}).update(cfg["model_limits"])
        elif "model_limits" not in state:
            state["model_limits"] = {}

    async def set_auth(payload: str) -> None:
        state["api_key"] = str(payload or "").strip() or None

    async def _get_jwt_from_cookie() -> tuple[str, str] | None:
        cookie = state.get("cookie") or cookie_header_for("groq.com")["header"]
        if not cookie:
            return None

        cookies = {}
        for item in cookie.split("; "):
            if "=" in item:
                k, v = item.split("=", 1)
                cookies[k] = v

        jwt = cookies.get("stytch_session_jwt")
        if jwt:
            org_id = _org_id_from_jwt(jwt)
            if org_id:
                return jwt, org_id

        session_token = cookies.get("stytch_session")
        if not session_token:
            return None

        client = create_client()
        try:
            result = await _exchange_stytch_session(
                session_token,
                state["stytch_public_token"],
                state["stytch_url"],
                client,
            )
            return result
        finally:
            await client.aclose()

    async def fetch() -> str:
        jwt = None
        org_id = None

        cookie_result = await _get_jwt_from_cookie()
        if cookie_result:
            jwt, org_id = cookie_result

        if not jwt or not org_id:
            raise AuthExpiredError("no Groq browser session cookie (stytch_session or stytch_session_jwt) found in Firefox")

        client = create_client()
        try:
            now = int(_dt.datetime.now(_dt.timezone.utc).timestamp())
            one_week_ago = now - (7 * 24 * 3600)

            res = await client.get(
                f"{ACTIVITY_URL}/organizations/{org_id}/activity",
                headers={
                    "Authorization": f"Bearer {jwt}",
                    "groq-organization": org_id,
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                },
                params={
                    "start_date": one_week_ago,
                    "end_date": now,
                },
            )

            if res.status_code in (401, 403):
                raise AuthExpiredError()
            if res.status_code == 429:
                ra = res.headers.get("retry-after")
                raise RateLimitedError(int(ra) if ra and ra.isdigit() else None)
            if res.status_code >= 400:
                raise RuntimeError(f"api.groq.com HTTP {res.status_code}")

            data = res.json()
            entries = data.get("data", []) if isinstance(data, dict) else []
            agg = _aggregate_activity_data(entries)
            model_limits = {**GROQ_FREE_TIER_MODEL_LIMITS, **state.get("model_limits", {})}
            data["_groq_model_limits"] = model_limits
            raw_json = json.dumps(data)
            state["last_agg"] = agg
            state["last_raw"] = raw_json
            return raw_json

        finally:
            await client.aclose()

    def interval_seconds() -> int:
        return 900

    def meta() -> dict:
        return {}

    return {
        "id": ID,
        "label": LABEL,
        "auth": {"kind": "cookie"},
        "config": config,
        "configure": configure,
        "set_auth": set_auth,
        "fetch": fetch,
        "interval_seconds": interval_seconds,
        "meta": meta,
        "parse": parse,
    }