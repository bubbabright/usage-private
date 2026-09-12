"""Groq usage provider plugin (console session + activity API).

Authenticates through the user's Firefox session (stytch_session_jwt or
stytch_session) and reads real usage metrics from the Groq platform
activity API. Replaces the old approach of making fake chat completions
to read rate-limit headers.

Auth flow (matches the console SPA / CodexBar reference):
  1. Read stytch_session (opaque, ~30 day) from Firefox cookies and
     exchange it for a fresh JWT via the Stytch B2B SDK endpoint (POST
     /sdk/v1/b2b/sessions/authenticate); org_id comes from the JWT claim.
  2. Fallback: read stytch_session_jwt (short-lived) directly when no
     opaque session exists or the exchange fails.

Endpoints:
  - GET https://api.groq.com/platform/v1/organizations/{orgId}/activity
    Returns per-model, per-day usage: cost, tokens, requests.
  - Stytch exchange: https://api.stytchb2b.groq.com/sdk/v1/b2b/sessions/authenticate

Known free-tier daily limits (console.groq.com/docs/rate-limits, 2026-09):
  requests/day (RPD) and tokens/day (TPD) per model, config-overridable
  via model_limits / model_token_limits. Cached tokens don't count toward
  rate limits, so token windows use non-cached + generated tokens only.
  - llama-3.1-8b-instant: 14,400 req/day (legacy listing)
  - whisper-large-v3(-turbo), distil-whisper-large-v3: 2,000 req/day
  - openai/gpt-oss-* and qwen/qwen3.x-27b: 1,000 req/day, 200K tok/day
  - meta-llama/llama-prompt-guard-2-*: 14,400 req/day, 500K tok/day
  - canopylabs/orpheus-*: 100 req/day, 3.6K tok/day
  - groq/compound(-mini): 250 req/day

The default Stytch public token is Groq's publishable console token (by
design — it only authorizes SDK calls from console.groq.com's origin); it
and the Stytch base URL can be overridden with GROQ_STYTCH_PUBLIC_TOKEN /
GROQ_STYTCH_URL env vars or the stytch_public_token / stytch_url config
keys if Groq rotates them.
"""

from __future__ import annotations

import base64
import datetime as _dt
import json
import math
import os
from typing import Any

import httpx

from ..cookiejar import cookie_header_for
from ..errors import AuthExpiredError, ProviderError, RateLimitedError
from ..httputil import create_client

COST_COLOR = "#D55E00"
TOKENS_COLOR = "#0072B2"
REQUESTS_COLOR = "#CC79A7"
DAILY_LIMIT_COLOR = "#000000"
DAILY_TOKEN_LIMIT_COLOR = "#8E44AD"

GROQ_FREE_TIER_MODEL_LIMITS = {
    "llama-3.1-8b-instant": 14400,
    "whisper-large-v3": 2000,
    "whisper-large-v3-turbo": 2000,
    "distil-whisper-large-v3": 2000,
    "canopylabs/orpheus-arabic-saudi": 100,
    "canopylabs/orpheus-v1-english": 100,
    "groq/compound": 250,
    "groq/compound-mini": 250,
    "meta-llama/llama-prompt-guard-2-22m": 14400,
    "meta-llama/llama-prompt-guard-2-86m": 14400,
    "openai/gpt-oss-120b": 1000,
    "openai/gpt-oss-20b": 1000,
    "openai/gpt-oss-safeguard-20b": 1000,
    "qwen/qwen3.6-27b": 1000,
    "qwen/qwen3.8-27b": 1000,
}

GROQ_FREE_TIER_TOKEN_LIMITS = {
    "llama-3.1-8b-instant": 500000,
    "canopylabs/orpheus-arabic-saudi": 3600,
    "canopylabs/orpheus-v1-english": 3600,
    "meta-llama/llama-prompt-guard-2-22m": 500000,
    "meta-llama/llama-prompt-guard-2-86m": 500000,
    "openai/gpt-oss-120b": 200000,
    "openai/gpt-oss-20b": 200000,
    "openai/gpt-oss-safeguard-20b": 200000,
    "qwen/qwen3.6-27b": 200000,
    "qwen/qwen3.8-27b": 200000,
}

ID = "groq"
LABEL = "Groq"

DEFAULT_STYTCH_PUBLIC_TOKEN = "public-token-live-58df57a9-a1f5-4066-bc0c-2ff942db684f"
DEFAULT_STYTCH_URL = "https://api.stytchb2b.groq.com"
ACTIVITY_URL = "https://api.groq.com/platform/v1"
ACTIVITY_HISTORY_DAYS = 30
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
    """Exchange opaque stytch_session for fresh JWT and org_id.

    Mirrors the console SPA / CodexBar request: Basic auth with the
    publishable token, the base64 Stytch SDK telemetry header, and a JSON
    body asking for a fresh session_jwt.
    """
    auth_header = base64.b64encode(f"{public_token}:{session_token}".encode()).decode()
    sdk_client_blob = base64.b64encode(
        json.dumps({
            "app": {"identifier": "console.groq.com"},
            "sdk": {"identifier": "Stytch.js Javascript SDK", "version": "5.43.0"},
        }, separators=(",", ":")).encode()
    ).decode()

    headers = {
        "Authorization": f"Basic {auth_header}",
        "X-SDK-Client": sdk_client_blob,
        "X-SDK-Parent-Host": "console.groq.com",
        "Origin": "https://console.groq.com",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    }

    try:
        res = await client.post(
            f"{stytch_url}/sdk/v1/b2b/sessions/authenticate",
            headers=headers,
            json={
                "session_token": session_token,
                "session_duration_minutes": 30,
            },
        )
        if res.status_code != 200:
            return None
        data = res.json()
        inner = data.get("data") if isinstance(data, dict) else None
        session_jwt = inner.get("session_jwt") if isinstance(inner, dict) else None
        if not session_jwt and isinstance(data, dict):
            session = data.get("session")
            session_jwt = session.get("jwt") if isinstance(session, dict) else None
        if not session_jwt:
            return None
        org_id = _org_id_from_jwt(session_jwt)
        if not org_id:
            return None
        return session_jwt, org_id
    except Exception:
        return None


def _aggregate_activity_data(entries: list[dict]) -> dict:
    """Aggregate activity entries into per-model totals for the last month.

    Matches the activity API request window: start of the UTC day N days ago
    through the end of the current UTC day. Also tracks each model's request
    count for the current UTC day (``requests_today``) so daily-limit windows
    compare against the per-day cap instead of the month total.
    """
    now = _dt.datetime.now(_dt.timezone.utc)
    day_start = int(now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
    window_end = day_start + (24 * 3600)
    start_ts = day_start - ((ACTIVITY_HISTORY_DAYS - 1) * 24 * 3600)

    model_stats: dict[str, dict] = {}

    for entry in entries:
        ts = entry.get("timestamp")
        if not _num(ts):
            continue
        ts = int(ts)

        if ts < start_ts or ts >= window_end:
            continue

        model = entry.get("model") or "unknown"
        if model not in model_stats:
            model_stats[model] = {
                "context_tokens": 0,
                "non_cached_tokens": 0,
                "generated_tokens": 0,
                "requests": 0,
                "requests_today": 0,
                "tokens_today": 0,
                "cost": 0.0,
            }
        model_stats[model]["context_tokens"] += _as_num(entry.get("n_context_tokens_total")) or 0
        non_cached = _as_num(entry.get("n_non_cached_context_tokens_total")) or 0
        generated = _as_num(entry.get("n_generated_tokens_total")) or 0
        model_stats[model]["non_cached_tokens"] += non_cached
        model_stats[model]["generated_tokens"] += generated
        reqs = _as_num(entry.get("num_requests")) or 0
        model_stats[model]["requests"] += reqs
        if ts >= day_start:
            model_stats[model]["requests_today"] += reqs
            # Cached tokens don't count toward rate limits (Groq docs).
            model_stats[model]["tokens_today"] += non_cached + generated
        model_stats[model]["cost"] += _as_num(entry.get("cost")) or 0.0

    return {
        "model_stats": model_stats,
    }


def _daily_limit_windows(model_stats: dict, model_limits: dict, token_limits: dict | None = None) -> list[dict]:
    """Build daily request- and token-limit windows for models with known limits."""
    token_limits = token_limits or {}
    windows = []
    for model, stats in model_stats.items():
        limit = model_limits.get(model)
        if limit:
            reqs = int(stats.get("requests_today", 0))
            if reqs > 0:
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
        tlimit = token_limits.get(model)
        if tlimit:
            toks = int(stats.get("tokens_today", 0))
            if toks > 0:
                pct = (100.0 * toks) / tlimit
                windows.append({
                    "id": f"daily_tokens_{model.replace('/', '_').replace('-', '_')}",
                    "label": f"{model} daily tokens",
                    "letter": "T",
                    "pct": max(0.0, min(100.0, pct)),
                    "used": toks,
                    "cap": tlimit,
                    "unit": "tokens",
                    "resets_at": _start_of_next_day(),
                    "color": DAILY_TOKEN_LIMIT_COLOR,
                    "will_deplete": False,
                })
    return windows


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
    model_token_limits = data.get("_groq_model_token_limits") or {}

    total_cost = _total_cost(agg)
    total_tokens = _total_generated_tokens(agg)
    total_context = _total_context_tokens(agg)
    total_reqs = _total_requests(agg)

    windows = []

    if total_cost > 0:
        windows.append({
            "id": "cost",
            "label": "Cost (30d)",
            "letter": "$",
            "pct": None,
            "used": total_cost,
            "cap": None,
            "unit": "USD",
            "resets_at": None,
            "color": COST_COLOR,
            "will_deplete": False,
        })

    if total_tokens > 0:
        windows.append({
            "id": "generated_tokens",
            "label": "Tokens (30d)",
            "letter": "Tk",
            "pct": None,
            "used": total_tokens,
            "cap": None,
            "unit": "tokens",
            "resets_at": None,
            "color": TOKENS_COLOR,
            "will_deplete": False,
        })

    if total_context > 0:
        windows.append({
            "id": "context_tokens",
            "label": "Context (30d)",
            "letter": "Ctx",
            "pct": None,
            "used": total_context,
            "cap": None,
            "unit": "tokens",
            "resets_at": None,
            "color": TOKENS_COLOR,
            "will_deplete": False,
        })

    if total_reqs > 0:
        windows.append({
            "id": "requests",
            "label": "Requests (30d)",
            "letter": "Req",
            "pct": None,
            "used": total_reqs,
            "cap": None,
            "unit": "calls",
            "resets_at": None,
            "color": REQUESTS_COLOR,
            "will_deplete": False,
        })

    for w in _daily_limit_windows(agg.get("model_stats", {}), model_limits, model_token_limits):
        windows.append(w)

    if not windows:
        raise ProviderError("no usable Groq activity data")

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
        "stytch_public_token": os.environ.get("GROQ_STYTCH_PUBLIC_TOKEN") or DEFAULT_STYTCH_PUBLIC_TOKEN,
        "stytch_url": os.environ.get("GROQ_STYTCH_URL") or DEFAULT_STYTCH_URL,
        "model_limits": {},
        "model_token_limits": {},
    }

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://console.groq.com/usage",
            "auth": {"kind": "cookie"},
            "windows": [
                {"id": "cost", "label": "Cost (30d)", "color": COST_COLOR},
                {"id": "generated_tokens", "label": "Tokens (30d)", "color": TOKENS_COLOR},
                {"id": "context_tokens", "label": "Context (30d)", "color": TOKENS_COLOR},
                {"id": "requests", "label": "Requests (30d)", "color": REQUESTS_COLOR},
            ],
            "tiers": [],
            "model_limits": {**GROQ_FREE_TIER_MODEL_LIMITS, **state.get("model_limits", {})},
            "model_token_limits": {**GROQ_FREE_TIER_TOKEN_LIMITS, **state.get("model_token_limits", {})},
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
        if "model_token_limits" in cfg and isinstance(cfg["model_token_limits"], dict):
            # Merge custom token limits with defaults
            state.setdefault("model_token_limits", {}).update(cfg["model_token_limits"])
        elif "model_token_limits" not in state:
            state["model_token_limits"] = {}

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

        session_token = cookies.get("stytch_session")
        jwt = cookies.get("stytch_session_jwt")

        if session_token:
            public_token = state.get("stytch_public_token")
            if not public_token:
                raise AuthExpiredError(
                    "stytch_session cookie requires a Stytch public token "
                    "(set GROQ_STYTCH_PUBLIC_TOKEN env or stytch_public_token config)"
                )
            client = create_client()
            try:
                result = await _exchange_stytch_session(
                    session_token,
                    public_token,
                    state["stytch_url"],
                    client,
                )
                if result:
                    return result
            finally:
                await client.aclose()
            # Exchange failed — fall through to a directly-readable JWT.

        if jwt:
            org_id = _org_id_from_jwt(jwt)
            if org_id:
                return jwt, org_id

        return None

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
            today_start = _dt.datetime.now(_dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
            start_date = int((today_start - _dt.timedelta(days=ACTIVITY_HISTORY_DAYS - 1)).timestamp())
            end_date = int((today_start + _dt.timedelta(days=1)).timestamp())

            res = await client.get(
                f"{ACTIVITY_URL}/organizations/{org_id}/activity",
                headers={
                    "Authorization": f"Bearer {jwt}",
                    "groq-organization": org_id,
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                },
                params={
                    "start_date": start_date,
                    "end_date": end_date,
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
            model_limits = {**GROQ_FREE_TIER_MODEL_LIMITS, **state.get("model_limits", {})}
            data["_groq_model_limits"] = model_limits
            model_token_limits = {**GROQ_FREE_TIER_TOKEN_LIMITS, **state.get("model_token_limits", {})}
            data["_groq_model_token_limits"] = model_token_limits
            raw_json = json.dumps(data)
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