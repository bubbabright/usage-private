"""Tavily usage provider plugin (port of src/providers/tavily.js)."""

from __future__ import annotations

import json
import math
from typing import Any

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

CREDITS_COLOR = "#D55E00"

ID = "tavily"
LABEL = "Tavily"

API_URL = "https://app.tavily.com"
ACCOUNT_PATH = "/api/account"
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
        raise AuthExpiredError("unparseable tavily envelope")
    if not isinstance(env, dict):
        raise AuthExpiredError("unparseable tavily envelope")
    if env.get("error") or env.get("success") is False:
        raise AuthExpiredError(f"tavily: {env.get('error') or 'request rejected'}")

    usage = env.get("usage") if _num(env.get("usage")) else None
    limit = env.get("limit") if _num(env.get("limit")) else None
    if usage is None:
        raise AuthExpiredError("no usable Tavily usage figure in envelope")
    usage_value = _as_num(usage)
    assert usage_value is not None
    limit_value = _as_num(limit)

    windows = [{
        "id": "credits",
        "label": "Credits",
        "letter": "Cr",
        "pct": _clamp_pct((usage_value / limit_value) * 100) if limit_value is not None and limit_value > 0 else None,
        "used": (limit_value - usage_value) if limit_value is not None else None,
        "used_is_remaining": True,
        "cap": limit_value,
        "unit": "searches",
        "resets_at": env.get("last_reset") or None,
        "color": CREDITS_COLOR,
        "will_deplete": False,
    }]

    return {
        "tier": env.get("current_plan") or None,
        "windows": windows,
        "segments": [],
        "_credits": {
            "usage": usage_value,
            "limit": limit_value,
            "plan": env.get("current_plan") or None,
            "plan_display_name": env.get("plan_display_name") or None,
            "last_reset": env.get("last_reset") or None,
        },
    }


def create() -> dict:
    state: dict[str, Any] = {"cookie": None, "last_credits": None}

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://app.tavily.com/billing",
            "auth": {"kind": "cookie"},
            "category": "support",
            "windows": [{"id": "credits", "label": "Credits", "color": CREDITS_COLOR}],
            "tiers": [],
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        if "cookie" in cfg:
            state["cookie"] = str(cfg["cookie"]).strip() if cfg["cookie"] else None

    async def fetch() -> str:
        if not state["cookie"]:
            raise AuthExpiredError("no Tavily session cookie configured")
        c = create_client()
        try:
            res = await c.get(
                f"{API_URL}{ACCOUNT_PATH}",
                headers={
                    "Cookie": state["cookie"],
                    "User-Agent": USER_AGENT,
                    "Accept": "*/*",
                },
            )
        finally:
            await c.aclose()
        if res.status_code in (401, 403):
            raise AuthExpiredError()
        if res.status_code == 429:
            ra = res.headers.get("retry-after")
            raise RateLimitedError(int(ra) if ra and ra.isdigit() else None)
        if res.status_code >= 400:
            raise RuntimeError(f"app.tavily.com HTTP {res.status_code}")
        body = res.json()
        envelope = {
            "usage": body.get("usage") if isinstance(body, dict) and _num(body.get("usage")) else None,
            "limit": body.get("limit") if isinstance(body, dict) and _num(body.get("limit")) else None,
            "last_reset": body.get("last_reset") if isinstance(body, dict) else None,
            "current_plan": body.get("current_plan") if isinstance(body, dict) else None,
            "plan_display_name": body.get("plan_display_name") if isinstance(body, dict) else None,
        }
        raw = json.dumps(envelope)
        state["last_credits"] = parse(raw)["_credits"]
        return raw

    def meta() -> dict:
        s = state["last_credits"]
        if not s:
            return {}
        return {"usage": s["usage"], "limit": s["limit"], "plan": s["plan"]}

    return {
        "id": ID,
        "label": LABEL,
        "auth": {"kind": "cookie"},
        "config": config,
        "configure": configure,
        "fetch": fetch,
        "interval_seconds": lambda: 300,
        "meta": meta,
        "parse": parse,
    }
