"""OpenRouter usage provider plugin (port of src/providers/openrouter.js)."""

from __future__ import annotations

import json
import math
from typing import Any

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

LIMIT_COLOR = "#56B4E9"
CREDITS_COLOR = "#E69F00"

ID = "openrouter"
LABEL = "OpenRouter"

KEY_URL = "https://openrouter.ai/api/v1/key"
CREDITS_URL = "https://openrouter.ai/api/v1/credits"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) usage-daemon/0.1"


def _clamp_pct(n):
    if not isinstance(n, (int, float)) or isinstance(n, bool) or not math.isfinite(n):
        return None
    return max(0.0, min(100.0, float(n)))


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _as_num(v) -> float | None:
    return float(v) if _num(v) else None


def _usage_for_reset(key_data: dict) -> float | None:
    reset = key_data.get("limit_reset")
    if not isinstance(reset, str) or not reset:
        return None
    field = {
        "daily": "usage_daily",
        "weekly": "usage_weekly",
        "monthly": "usage_monthly",
    }.get(reset.lower())
    return _as_num(key_data.get(field)) if field else None


def parse(raw) -> dict:
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

    if not windows:
        raise RuntimeError("OpenRouter returned no usable meter (no key limit, no credits data)")

    return {
        "tier": tier,
        "windows": windows,
        "segments": [],
        "_openrouter": {
            **(key_stats or {}),
            **(credits_stats or {}),
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
                {"id": "credits", "label": "Balance", "color": CREDITS_COLOR},
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

        key = None
        credits = None
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
        finally:
            await c.aclose()

        if not key and not credits:
            if rate_limited is not None:
                raise RateLimitedError(rate_limited)
            if key_denied and credits_denied:
                raise AuthExpiredError("OpenRouter rejected this key on both /key and /credits")
            raise RuntimeError("openrouter.ai returned no usable body")

        raw = json.dumps({"key": key, "credits": credits})
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
