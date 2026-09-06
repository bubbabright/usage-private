"""Abacus.AI ChatLLM usage provider plugin (port of src/providers/abacus.js).

Compute points from _getCompleteUserInfo; auth is the browser session cookie.
Raw values are centi-credits (100x) — parse() divides by 100 (verified live
2026-08-27 against the site's own panel). Free-tier credits are a one-time
bucket: resets_at carries the bucket EXPIRY (freeTierExpiresAt), not a refresh.
"""

from __future__ import annotations

import json

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

CREDITS_COLOR = "#CC79A7"  # Okabe-Ito pink

ID = "abacus"
LABEL = "Abacus.AI"

API_URL = "https://apps.abacus.ai/api/v1/_getCompleteUserInfo"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0"


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _load(raw):
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable abacus response")
    if not isinstance(data, dict):
        raise AuthExpiredError("unparseable abacus response")
    return data


def parse(raw) -> dict:
    """Pure function of the raw API JSON text — no fs/network."""
    data = _load(raw)

    # API always returns { success, result } — auth failures redirect, not JSON.
    if not data.get("success"):
        raise AuthExpiredError("abacus API returned unsuccessful")

    org = ((data.get("result") or {}).get("userInfo") or {}).get("organization")
    if not org:
        raise AuthExpiredError("no organization info in abacus response")

    cpi = org.get("computePointInfo")
    tier = org.get("subscriptionTier") if org.get("subscriptionTier") is not None else "unknown"
    is_free_tier = bool(((org.get("info") or {}).get("is_free_tier")))

    if not cpi or not _num(cpi.get("currMonthAvailPoints")) or not _num(cpi.get("currMonthUsage")):
        raise AuthExpiredError("no usable compute point figures in abacus response")

    # Raw values are centi-credits (100x real credits) — divide by 100 so the
    # UI shows real credits.
    used = cpi["currMonthUsage"] / 100  # real credits consumed
    cap = cpi["currMonthAvailPoints"] / 100  # real credits total
    pct = max(0, min(100, (100 * used) / cap)) if cap > 0 else 0

    # Free tier credits don't refresh — one-time bucket with a hard expiry.
    # Surface that date as resets_at (countdown = time left until it vanishes);
    # expires_at repeats it explicitly for clients that label it "expires".
    resets_at = cpi.get("freeTierExpiresAt")
    if resets_at is None:
        resets_at = None

    window = {
        "id": "compute_points",
        "label": "Credits",
        "letter": "Cr",
        "pct": pct,
        "used": used,
        "cap": cap,
        "unit": "credits",
        "resets_at": resets_at,
        "expires_at": resets_at,
        "color": CREDITS_COLOR,
        "will_deplete": False,
    }
    if is_free_tier:
        window["note"] = "Free-tier credits — one-time grant, does not refresh"

    return {
        "tier": tier,
        "windows": [window],
        "segments": [],
        # Surface raw figures for meta() — lets the UI show remaining alongside bar.
        "_abacus": {
            "used": cpi["currMonthUsage"],  # raw centi-credits, unconverted
            "cap": cpi["currMonthAvailPoints"],
            "is_free_tier": is_free_tier,
            "free_tier_expires": cpi.get("freeTierExpiresAt"),
        },
    }


def create() -> dict:
    state = {"cookie": None}

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://apps.abacus.ai/chatllm/admin/profile",
            "auth": {"kind": "cookie"},
            "windows": [{"id": "compute_points", "label": "Credits", "color": CREDITS_COLOR}],
            "tiers": ["free", "pro", "max", "enterprise"],
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        if "cookie" in cfg:
            state["cookie"] = cfg["cookie"]

    async def fetch() -> str:
        if not state["cookie"]:
            raise AuthExpiredError("no abacus cookie configured")

        c = create_client()  # follow_redirects=False == JS redirect: 'manual'
        try:
            res = await c.post(
                API_URL,
                headers={
                    "Cookie": state["cookie"],
                    "User-Agent": USER_AGENT,
                    "Accept": "*/*",
                    "Content-Type": "application/json",
                    "REAI-UI": "1",
                    "X-Abacus-Org-Host": "apps",
                },
                content=json.dumps({"isDesktop": True}),
            )
        finally:
            await c.aclose()

        # 3xx redirect = logged out.
        if 300 <= res.status_code < 400:
            raise AuthExpiredError()
        if res.status_code == 429:
            ra = res.headers.get("retry-after")
            raise RateLimitedError(int(ra) if ra and ra.isdigit() else None)
        if res.status_code >= 400:
            raise RuntimeError(f"apps.abacus.ai HTTP {res.status_code}")

        return res.text

    def interval_seconds() -> int:
        return 300

    return {
        "id": ID,
        "label": LABEL,
        "auth": {"kind": "cookie"},
        "config": config,
        "configure": configure,
        "fetch": fetch,
        "interval_seconds": interval_seconds,
        "parse": parse,
    }
