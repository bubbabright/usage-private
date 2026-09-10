"""Firecrawl usage provider plugin (port of src/providers/firecrawl.js)."""

from __future__ import annotations

import json
import math
from typing import Any

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

CREDITS_COLOR = "#0072B2"

ID = "firecrawl"
LABEL = "Firecrawl"

DEFAULT_API_URL = "https://api.firecrawl.dev"
CREDIT_USAGE_PATH = "/v2/team/credit-usage"
USER_AGENT = "usage-daemon/0.1"


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _as_num(v) -> float | None:
    return float(v) if _num(v) else None


def slice_credits(remaining, plan):
    m = ((remaining % plan) + plan) % plan
    slice_remaining = plan if m == 0 and remaining > 0 else m
    cycles = math.floor(remaining / plan)
    return {"cycles": cycles, "sliceRemaining": slice_remaining}


def parse(raw) -> dict:
    try:
        env = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable firecrawl envelope")
    if not isinstance(env, dict):
        raise AuthExpiredError("unparseable firecrawl envelope")
    if env.get("error") or env.get("success") is False:
        raise AuthExpiredError(f"firecrawl: {env.get('error') or 'request rejected'}")

    remaining = env.get("remaining_credits")
    plan = env.get("plan_credits")
    if not _num(remaining):
        raise AuthExpiredError("no usable Firecrawl credit figures in envelope")
    remaining_value = _as_num(remaining)
    assert remaining_value is not None

    pct = None
    cycles_remaining = None
    slice_remaining = None
    plan_value = _as_num(plan)
    if plan_value is not None and plan_value > 0:
        sliced = slice_credits(remaining_value, plan_value)
        cycles_remaining = sliced["cycles"]
        slice_remaining = sliced["sliceRemaining"]

    windows = [{
        "id": "credits",
        "label": "Credits",
        "letter": "Cr",
        "pct": pct,
        "used": remaining_value,
        "used_is_remaining": True,
        "cap": plan_value if plan_value is not None and plan_value > 0 else None,
        "unit": "credits",
        "cycles_remaining": cycles_remaining,
        "resets_at": env.get("period_end") or None,
        "color": CREDITS_COLOR,
        "will_deplete": False,
    }]

    return {
        "tier": None,
        "windows": windows,
        "segments": [],
        "_credits": {
            "remaining": remaining_value,
            "plan": plan_value,
            "cycles_remaining": cycles_remaining,
            "slice_remaining": slice_remaining,
            "period_start": env.get("period_start") or None,
            "period_end": env.get("period_end") or None,
        },
    }


def create() -> dict:
    state: dict[str, Any] = {"api_key": None, "api_url": DEFAULT_API_URL, "last_credits": None}

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://www.firecrawl.dev/app/usage",
            "auth": {"kind": "token"},
            "category": "support",
            "windows": [{"id": "credits", "label": "Credits", "color": CREDITS_COLOR}],
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
            raise AuthExpiredError("no Firecrawl API key configured")
        c = create_client()
        try:
            res = await c.get(
                f"{state['api_url']}{CREDIT_USAGE_PATH}",
                headers={
                    "Authorization": f"Bearer {state['api_key']}",
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
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
            raise RuntimeError(f"api.firecrawl.dev HTTP {res.status_code}")
        body = res.json()
        cfg: dict[str, Any]
        if isinstance(body, dict) and isinstance(body.get("data"), dict):
            cfg = body["data"]
        elif isinstance(body, dict):
            cfg = body
        else:
            cfg = {}
        envelope = {
            "remaining_credits": cfg.get("remainingCredits") if _num(cfg.get("remainingCredits")) else None,
            "plan_credits": cfg.get("planCredits") if _num(cfg.get("planCredits")) else None,
            "period_start": cfg.get("billingPeriodStart") or None,
            "period_end": cfg.get("billingPeriodEnd") or None,
        }
        raw = json.dumps(envelope)
        state["last_credits"] = parse(raw)["_credits"]
        return raw

    def meta() -> dict:
        s = state["last_credits"]
        if not s:
            return {}
        return {
            "credits_remaining": s["remaining"],
            "plan_credits": s["plan"],
            "cycles_remaining": s["cycles_remaining"],
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
