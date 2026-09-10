"""Context7 usage provider plugin (port of src/providers/context7.js)."""

from __future__ import annotations

import json
import math
from typing import Any
from urllib.parse import quote

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

REQUESTS_COLOR = "#F0E442"

ID = "context7"
LABEL = "Context7"

API_URL = "https://context7.com"
USER_AGENT = "usage-daemon/0.1"


def _clamp_pct(n):
    if not isinstance(n, (int, float)) or isinstance(n, bool) or not math.isfinite(n):
        return None
    return max(0.0, min(100.0, float(n)))


def parse(raw) -> dict:
    try:
        env = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable context7 envelope")
    if not isinstance(env, dict):
        raise AuthExpiredError("unparseable context7 envelope")
    if env.get("success") is not True or not isinstance(env.get("data"), dict):
        raise AuthExpiredError("context7: not authenticated")

    data = env["data"]
    consumed = data.get("userRequests") if isinstance(data.get("userRequests"), (int, float)) and not isinstance(data.get("userRequests"), bool) else None
    cap = data.get("quotaLimit") if isinstance(data.get("quotaLimit"), (int, float)) and not isinstance(data.get("quotaLimit"), bool) else None
    if consumed is None:
        raise AuthExpiredError("no usable Context7 request figure in envelope")

    windows = [{
        "id": "requests",
        "label": "Requests/mo",
        "letter": "Rq",
        "pct": _clamp_pct((100 * consumed) / cap) if cap is not None and cap > 0 else None,
        "used": max(0, cap - consumed) if cap is not None else None,
        "used_is_remaining": True,
        "cap": cap,
        "unit": "requests",
        "resets_at": None,
        "color": REQUESTS_COLOR,
        "will_deplete": False,
    }]

    return {
        "tier": data.get("ownerPlan") or None,
        "windows": windows,
        "segments": [],
        "_context7": {
            "quotaLimit": cap,
            "userRequests": consumed,
            "ownerPlan": data.get("ownerPlan") or None,
            "creditBalance": data.get("creditBalance") if isinstance(data.get("creditBalance"), (int, float)) and not isinstance(data.get("creditBalance"), bool) else None,
        },
    }


def create() -> dict:
    state: dict[str, Any] = {"cookie": None, "team_id": None, "last_stats": None}

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://context7.com/dashboard",
            "auth": {"kind": "cookie"},
            "category": "support",
            "windows": [{"id": "requests", "label": "Requests/mo", "color": REQUESTS_COLOR}],
            "tiers": [],
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        if "cookie" in cfg:
            state["cookie"] = str(cfg["cookie"]).strip() if cfg["cookie"] else None
        if "team_id" in cfg:
            state["team_id"] = str(cfg["team_id"]).strip() if cfg["team_id"] else None

    async def fetch() -> str:
        if not state["cookie"]:
            raise AuthExpiredError("no Context7 session cookie configured")
        if not state["team_id"]:
            raise RuntimeError("context7: no team_id configured (see config.example.toml)")
        c = create_client()
        try:
            res = await c.get(
                f"{API_URL}/api/dashboard/stats/{quote(state['team_id'], safe='')}",
                headers={
                    "Cookie": state["cookie"],
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                    "Referer": "https://context7.com/dashboard",
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
            raise RuntimeError(f"context7.com HTTP {res.status_code}")
        state["last_stats"] = parse(res.text)["_context7"]
        return res.text

    def meta() -> dict:
        s = state["last_stats"]
        if not s:
            return {}
        return {
            "quota_limit": s["quotaLimit"],
            "user_requests": s["userRequests"],
            "owner_plan": s["ownerPlan"],
            "credit_balance": s["creditBalance"],
        }

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
