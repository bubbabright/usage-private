"""LLM7 usage provider plugin (port of src/providers/llm7.js).

Token-level daily quota from api-token.llm7.io — the dashboard SESSION JWT, not
an API key (the classic mistake). Rolling 24h window from the first request, so
resets_at is None; 1M token daily limit on the free tier. Single meter:
daily_tokens used/limit with the raw remaining figure surfaced via meta().
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

TOKEN_COLOR = "#56B4E9"  # Okabe-Ito blue

ID = "llm7"
LABEL = "LLM7"

API_URL = "https://api-token.llm7.io/my/token-quota"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) usage-daemon/0.1"


def next_utc_midnight() -> str:
    now = datetime.now(timezone.utc)
    reset = now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    return reset.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _load(raw):
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable llm7 response")
    if not isinstance(data, dict):
        raise AuthExpiredError("unparseable llm7 response")
    return data


def parse(raw) -> dict:
    """Pure function of the raw API JSON text — no fs/network."""
    data = _load(raw)

    # Auth failures surface as { error, message }.
    if data.get("error"):
        raise AuthExpiredError(f"llm7: {data.get('message') or data.get('error')}")

    used = data.get("used_tokens")
    limit = data.get("limit_tokens")
    remaining = data.get("remaining_tokens")

    if (
        not isinstance(used, (int, float))
        or isinstance(used, bool)
        or not isinstance(limit, (int, float))
        or isinstance(limit, bool)
        or limit <= 0
    ):
        raise AuthExpiredError("no usable LLM7 token quota figures")

    pct = max(0, min(100, (100 * used) / limit))

    windows = [
        {
            "id": "daily_tokens",
            "label": "Tokens",
            "letter": "Tk",
            "pct": pct,
            "used": used,  # consumed tokens (2,431)
            "cap": limit,  # daily cap (1,000,000)
            "unit": "tokens",
            "resets_at": next_utc_midnight(),
            "color": TOKEN_COLOR,
            "will_deplete": False,
        }
    ]
    return {
        "tier": data.get("tier"),
        "windows": windows,
        "segments": [],
        # Surface the raw remaining figure for meta() — lets the UI show
        # "997,569 remaining" alongside the bar.
        "_llm7": {
            "remaining": remaining
            if isinstance(remaining, (int, float)) and not isinstance(remaining, bool) and math.isfinite(remaining)
            else None
        },
    }


def create() -> dict:
    state = {"api_token": None, "last_remaining": None}

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://dash.llm7.io/#/usage",
            # Not the LLM7 inference API key — the dashboard SESSION JWT.
            "auth": {
                "kind": "token",
                "relogin": "dashboard session JWT from dash.llm7.io (DevTools Network tab), not the API key",
            },
            "windows": [{"id": "daily_tokens", "label": "Tokens", "color": TOKEN_COLOR}],
            "tiers": [],
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        # `in` (JS !== undefined) so configure({api_token: ''}) can explicitly clear it.
        if "api_token" in cfg:
            state["api_token"] = str(cfg["api_token"]).strip() if cfg["api_token"] else None
        if "token" in cfg:
            state["api_token"] = str(cfg["token"]).strip() if cfg["token"] else state["api_token"]

    async def set_auth(payload: str) -> None:
        state["api_token"] = str(payload or "").strip() or None

    async def fetch() -> str:
        if not state["api_token"]:
            raise AuthExpiredError("no LLM7 token configured")

        c = create_client()
        try:
            res = await c.get(
                API_URL,
                headers={
                    "Authorization": f"Bearer {state['api_token']}",
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json, text/plain, */*",
                    "Origin": "https://dash.llm7.io",
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
            raise RuntimeError(f"api-token.llm7.io HTTP {res.status_code}")

        text = res.text
        # Cache remaining figure for meta()
        parsed = parse(text)
        state["last_remaining"] = (parsed.get("_llm7") or {}).get("remaining")
        return text

    def interval_seconds() -> int:
        return 300

    def meta() -> dict:
        return {"tokens_remaining": state["last_remaining"]} if state["last_remaining"] is not None else {}

    return {
        "id": ID,
        "label": LABEL,
        "auth": {"kind": "token"},
        "config": config,
        "configure": configure,
        "set_auth": set_auth,
        "fetch": fetch,
        "interval_seconds": interval_seconds,
        "meta": meta,
        "parse": parse,
    }
