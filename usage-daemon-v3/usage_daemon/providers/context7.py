"""Context7 usage provider plugin (port of src/providers/context7.js, plus a
Clerk session-refresh step).

Context7 authenticates the dashboard with Clerk, which issues its
``__session`` JWT with only a ~60-second lifetime and re-issues it while the
dashboard tab is open. A cookie pulled from Firefox on a poll schedule is
therefore almost always expired, so ``fetch()`` mints a fresh session JWT via
Clerk's frontend token endpoint (``POST /v1/client/sessions/<sid>/tokens``,
the same call Clerk's SDK makes) before hitting the stats API.
"""

from __future__ import annotations

import base64
import json
import math
from typing import Any
from urllib.parse import quote

import httpx

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

REQUESTS_COLOR = "#F0E442"

ID = "context7"
LABEL = "Context7"

API_URL = "https://context7.com"
FRONTEND_URL = "https://clerk.context7.com"
USER_AGENT = "usage-daemon/0.1"


def _jwt_payload(jwt: str) -> dict | None:
    try:
        seg = jwt.split(".")[1]
        seg += "=" * (-len(seg) % 4)
        data = json.loads(base64.urlsafe_b64decode(seg))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _session_id_from_jwt(jwt: str) -> str | None:
    payload = _jwt_payload(jwt)
    sid = payload.get("sid") if payload else None
    return sid if isinstance(sid, str) and sid else None


def _session_jwt_from_cookie_header(header: str) -> str | None:
    for part in header.split(";"):
        part = part.strip()
        if not part.lower().startswith("__session="):
            continue
        value = part.split("=", 1)[1].strip().strip('"')
        return value or None
    return None


async def _clerk_refresh_jwt(cookie_header: str, client: httpx.AsyncClient) -> str | None:
    """Mint a fresh Clerk session JWT from the browser's session cookies.

    Clerk's ``__session`` JWT lives ~60s, so we exchange the stored cookies
    (which identify the live session) for a brand-new JWT, then use it as the
    Bearer token against the Context7 API. Returns None when the cookie set
    has no usable Clerk session.
    """
    session_jwt = _session_jwt_from_cookie_header(cookie_header)
    if not session_jwt:
        return None
    sid = _session_id_from_jwt(session_jwt)
    if not sid:
        return None
    try:
        res = await client.post(
            f"{FRONTEND_URL}/v1/client/sessions/{sid}/tokens",
            headers={
                "Origin": "https://context7.com",
                "Referer": "https://context7.com/dashboard",
                "Cookie": cookie_header,
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            },
            json={},
        )
        if res.status_code != 200:
            return None
        jwt = res.json().get("jwt")
    except Exception:
        return None
    return jwt if isinstance(jwt, str) and jwt else None


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
            jwt = await _clerk_refresh_jwt(state["cookie"], c)
            if not jwt:
                raise AuthExpiredError(
                    "context7: could not refresh Clerk session — log in to context7.com "
                    "in Firefox and refresh the cookie"
                )
            res = await c.get(
                f"{API_URL}/api/dashboard/stats/{quote(state['team_id'], safe='')}",
                headers={
                    "Authorization": f"Bearer {jwt}",
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                    "Referer": "https://context7.com/dashboard",
                },
            )
        finally:
            await c.aclose()
        if res.status_code in (401, 403):
            raise AuthExpiredError("context7 session logged out — log in at context7.com and refresh the cookie")
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
