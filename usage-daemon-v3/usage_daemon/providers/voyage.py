"""Voyage AI free-token usage provider.

Voyage's dashboard keeps its backend access token in browser session storage;
the encrypted ``__session`` cookie is not accepted by the dashboard backend.
The provider therefore supports the dashboard bearer token through the normal
provider auth payload while still refreshing the browser cookie for metadata.
"""

from __future__ import annotations

import datetime as _dt
import os
import re
from typing import Any

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

ID = "voyage"
LABEL = "Voyage AI"
BACKEND_URL = "https://prod.dashboardbackend.voyageai.com"
USAGE_URL = "https://dashboard.voyageai.com/organization/usage?tab=free-token"
TOKEN_COLOR = "#00D4A8"


def _next_month() -> str:
    now = _dt.datetime.now(_dt.timezone.utc)
    if now.month == 12:
        reset = now.replace(year=now.year + 1, month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        reset = now.replace(month=now.month + 1, day=1, hour=0, minute=0, second=0, microsecond=0)
    return reset.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        match = re.search(r"-?[0-9][0-9,]*(?:\.[0-9]+)?", value)
        if match:
            return float(match.group(0).replace(",", ""))
    return None


def _find(data: Any, names: set[str]) -> float | None:
    if isinstance(data, dict):
        for key, value in data.items():
            if key.lower() in names:
                number = _number(value)
                if number is not None:
                    return number
        for value in data.values():
            found = _find(value, names)
            if found is not None:
                return found
    elif isinstance(data, list):
        for value in data:
            found = _find(value, names)
            if found is not None:
                return found
    return None


def parse(data: Any) -> dict:
    """Parse the free-token endpoint response, tolerating API casing changes."""
    rows = data.get("data", data) if isinstance(data, dict) else data
    if isinstance(rows, list):
        cap = sum((_number(r.get("totalFreeToken")) or 0) for r in rows if isinstance(r, dict))
        remaining = sum((_number(r.get("remainingToken")) or 0) for r in rows if isinstance(r, dict))
        used = cap - remaining
    else:
        used = _find(data, {"used", "used_tokens", "tokens_used", "consumed"})
        cap = _find(data, {"limit", "token_limit", "free_token_limit", "quota"})
        remaining = _find(data, {"remaining", "remaining_tokens", "tokens_remaining"})
    if cap is None and used is not None and remaining is not None:
        cap = used + remaining
    if used is None and cap is not None and remaining is not None:
        used = cap - remaining
    if used is None or cap is None or cap <= 0:
        raise AuthExpiredError("no usable Voyage AI free-token quota")
    return {
        "tier": "free",
        "windows": [{
            "id": "free_tokens",
            "label": "Free tokens",
            "letter": "Tk",
            "pct": max(0, min(100, 100 * used / cap)),
            "used": used,
            "cap": cap,
            "unit": "tokens",
            "resets_at": _next_month(),
            "color": TOKEN_COLOR,
            "will_deplete": False,
        }],
        "segments": [
            {
                "model": row["modelName"],
                "total_tokens": _number(row.get("totalFreeToken")),
                "remaining_tokens": _number(row.get("remainingToken")),
            }
            for row in rows if isinstance(row, dict) and row.get("modelName")
        ] if isinstance(rows, list) else [],
    }


def create() -> dict:
    state: dict[str, str | None] = {"token": None, "cookie": None}

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": USAGE_URL,
            "auth": {"kind": "cookie", "cookie_from_firefox": "dashboard.voyageai.com"},
            "category": "plan",
            "windows": [{"id": "free_tokens", "label": "Free tokens", "color": TOKEN_COLOR}],
            "tiers": ["free"],
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        if "api_token" in cfg:
            state["token"] = str(cfg["api_token"]).strip() or None
        elif cfg.get("api_token_file"):
            try:
                with open(os.path.expanduser(str(cfg["api_token_file"])), encoding="utf-8") as handle:
                    state["token"] = handle.read().strip() or None
            except OSError:
                state["token"] = None
        if "cookie" in cfg:
            state["cookie"] = str(cfg["cookie"]).strip() or None

    async def set_auth(value: str) -> None:
        state["token"] = value.strip() or None

    async def fetch() -> dict:
        client = create_client()
        try:
            token = state["token"]
            if not token and state["cookie"]:
                action = await client.post(
                    "https://dashboard.voyageai.com/organization/usage?tab=free-token",
                    headers={
                        "Cookie": state["cookie"],
                        "Next-Action": "00d99f2710a2253c76f06855ef641ff10d0c48a8ba",
                        "Content-Type": "text/plain;charset=UTF-8",
                        "Accept": "text/x-component",
                        "Origin": "https://dashboard.voyageai.com",
                        "Referer": USAGE_URL,
                        "User-Agent": "Mozilla/5.0",
                    },
                    content="[]",
                )
                if action.status_code in (401, 403):
                    raise AuthExpiredError("Voyage AI dashboard session expired")
                action.raise_for_status()
                match = re.search(r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_.-]{20,}", action.text)
                if not match:
                    raise AuthExpiredError("Voyage AI dashboard did not return an access token")
                token = match.group(0)
                state["token"] = token
            if not token:
                raise AuthExpiredError("no Voyage AI dashboard session configured")
            auth_headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
            orgs = await client.get(
                f"{BACKEND_URL}/api/org/list",
                headers=auth_headers,
            )
            if orgs.status_code in (401, 403):
                raise AuthExpiredError("Voyage AI access token expired")
            if orgs.status_code == 429:
                raise RateLimitedError()
            orgs.raise_for_status()
            payload = orgs.json()
            items = payload.get("data", payload) if isinstance(payload, dict) else payload
            if not isinstance(items, list) or not items:
                raise RuntimeError("Voyage AI returned no organizations")
            org_id = items[0].get("id") or items[0].get("org_id") if isinstance(items[0], dict) else None
            if not org_id:
                raise RuntimeError("Voyage AI organization response has no id")
            res = await client.get(
                f"{BACKEND_URL}/api/org/get_free_token/{org_id}",
                headers=auth_headers,
            )
            if res.status_code in (401, 403):
                raise AuthExpiredError("Voyage AI access token expired")
            if res.status_code == 429:
                raise RateLimitedError()
            res.raise_for_status()
            return res.json()
        finally:
            await client.aclose()

    return {
        "id": ID,
        "label": LABEL,
        "auth": {"kind": "cookie"},
        "config": config,
        "configure": configure,
        "set_auth": set_auth,
        "fetch": fetch,
        "interval_seconds": lambda: 300,
        "parse": parse,
    }
