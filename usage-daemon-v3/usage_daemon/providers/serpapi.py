"""SerpApi usage provider plugin (port of src/providers/serpapi.js)."""

from __future__ import annotations

import json
import math
from typing import Any
from urllib.parse import quote

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

SEARCHES_COLOR = "#E69F00"

ID = "serpapi"
LABEL = "SerpApi"

DEFAULT_API_URL = "https://serpapi.com"
ACCOUNT_PATH = "/account.json"
USER_AGENT = "usage-daemon/0.1"


def _clamp_pct(n):
    if not isinstance(n, (int, float)) or isinstance(n, bool) or not math.isfinite(n):
        return None
    return max(0.0, min(100.0, float(n)))


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _as_num(v) -> float | None:
    return float(v) if _num(v) else None


def parse(raw) -> dict:
    try:
        env = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable serpapi envelope")
    if not isinstance(env, dict):
        raise AuthExpiredError("unparseable serpapi envelope")
    if env.get("error"):
        raise AuthExpiredError(f"serpapi: {env['error']}")

    windows = []
    plan = env.get("searches_per_month")
    used = env.get("this_month_usage")
    left = env.get("plan_searches_left")
    plan_value = _as_num(plan)
    used_value = _as_num(used)
    if plan_value is not None and plan_value > 0 and used_value is not None:
        windows.append({
            "id": "monthly_searches",
            "label": "Searches/mo",
            "letter": "Sr",
            "pct": _clamp_pct(100 * (used_value / plan_value)),
            "used": left if _num(left) else max(0, plan_value - used_value),
            "used_is_remaining": True,
            "cap": plan_value,
            "unit": "searches",
            "resets_at": env.get("plan_renewal_date") or None,
            "color": SEARCHES_COLOR,
            "will_deplete": False,
        })

    total_left = env.get("total_searches_left")
    if not windows and _num(total_left):
        windows.append({
            "id": "total_searches",
            "label": "Searches left",
            "letter": "Sr",
            "pct": None,
            "used": total_left,
            "used_is_remaining": True,
            "unit": "searches",
            "resets_at": None,
            "color": SEARCHES_COLOR,
            "will_deplete": False,
        })

    if not windows:
        raise AuthExpiredError("no usable SerpApi account figures in envelope")

    return {
        "tier": None,
        "windows": windows,
        "segments": [],
        "_serpapi": {
            "plan": plan_value,
            "plan_searches_left": env.get("plan_searches_left") if _num(env.get("plan_searches_left")) else None,
            "this_month_usage": used if _num(used) else None,
            "total_searches_left": total_left if _num(total_left) else None,
            "extra_credits": env.get("extra_credits") if _num(env.get("extra_credits")) else None,
            "plan_renewal_date": env.get("plan_renewal_date") or None,
            "plan_monthly_price": env.get("plan_monthly_price") if _num(env.get("plan_monthly_price")) else None,
        },
    }


def create() -> dict:
    state: dict[str, Any] = {"api_key": None, "api_url": DEFAULT_API_URL, "last_account": None}

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://serpapi.com/account",
            "auth": {"kind": "token"},
            "category": "support",
            "windows": [{"id": "monthly_searches", "label": "Searches/mo", "color": SEARCHES_COLOR}],
            "tiers": [],
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        if "api_key" in cfg:
            state["api_key"] = str(cfg["api_key"]).strip() if cfg["api_key"] else None
        if cfg.get("api_url"):
            state["api_url"] = str(cfg["api_url"]).strip().rstrip("/")

    async def set_auth(payload: str) -> None:
        state["api_key"] = str(payload or "").strip() or None

    async def fetch() -> str:
        if not state["api_key"]:
            raise AuthExpiredError("no SerpApi API key configured")
        c = create_client()
        try:
            res = await c.get(
                f"{state['api_url']}{ACCOUNT_PATH}?api_key={quote(state['api_key'], safe='')}",
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            )
        finally:
            await c.aclose()
        if res.status_code in (401, 403):
            raise AuthExpiredError()
        if res.status_code == 429:
            ra = res.headers.get("retry-after")
            raise RateLimitedError(int(ra) if ra and ra.isdigit() else None)
        if res.status_code >= 400:
            raise RuntimeError(f"serpapi.com HTTP {res.status_code}")
        if isinstance(res.json(), dict) and res.json().get("error"):
            raise AuthExpiredError(f"serpapi: {res.json()['error']}")
        state["last_account"] = parse(res.text)["_serpapi"]
        return res.text

    def meta() -> dict:
        s = state["last_account"]
        if not s:
            return {}
        return {
            "searches_per_month": s["plan"],
            "plan_searches_left": s["plan_searches_left"],
            "this_month_usage": s["this_month_usage"],
            "total_searches_left": s["total_searches_left"],
            "extra_credits": s["extra_credits"],
            "plan_renewal_date": s["plan_renewal_date"],
        }

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
