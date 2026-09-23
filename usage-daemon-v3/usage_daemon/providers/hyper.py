"""Charm Hyper credits provider plugin (port of src/providers/hyper.js,
extended per the locked data model: tier + per-model usage from the dashboard).

Two sources:
  1. GET /v1/credits (Bearer API key)  -> {"balance": 78}
  2. GET /teams/<id>/dashboard (cookie) -> "Next Hypercredit Refresh in 2 weeks"
     (resets_at) + Plan card (tier) + "Usage by Model" table (segments).
     Optional; absent cookie => resets_at null, tier free, no segments.

Free tier: 200 credits/month (hardcoded — API doesn't return cap; verified on
the dashboard 2026-09). Used = cap - balance.
"""

from __future__ import annotations

import json
import re
import time as _time
from datetime import datetime, timezone

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

CREDITS_COLOR = "#0072B2"

ID = "hyper"
LABEL = "Charm Hyper"

CREDITS_URL = "https://hyper.charm.land/v1/credits"
DASHBOARD_URL = (
    "https://hyper.charm.land/teams/6b4e808f-3933-4bfd-a321-be1bcfe04f21/dashboard"
)
USER_AGENT = "usage-daemon"
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0"

PLAN_CAP = 200  # free tier: 200 credits/month


def parse_refresh_text(html: str) -> str | None:
    """Parse 'Next Hypercredit Refresh in 4 weeks' -> ISO timestamp."""
    m = re.search(
        r"Next Hypercredit Refresh in (\d+)\s+(day|days|week|weeks)", html, re.I
    )
    if not m:
        return None
    n = int(m.group(1))
    unit = m.group(2).lower()
    days = n * 7 if unit.startswith("week") else n
    ts = _time.time() + days * 24 * 3600
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


def parse_dashboard(html: str) -> dict:
    """Extract {tier, resets_at, segments} from the dashboard page (best-effort)."""
    res: dict = {}
    m = re.search(r">\s*Plan\s*</p>\s*<p[^>]*>\s*([A-Za-z]+)\s*<", html, re.S)
    if m:
        res["tier"] = m.group(1).lower()
    reset = parse_refresh_text(html)
    if reset:
        res["resets_at"] = reset

    segments = []
    for block in re.findall(r'<tr class="hover[^"]*">(.*?)</tr>', html, re.S):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", block, re.S)
        if len(cells) < 7:
            continue
        mname = re.search(r"<span[^>]*>([^<]+)</span>", cells[0])
        if not mname:
            continue

        def _num(td: str):
            mm = re.sub(r"[^0-9.]", "", td)
            return float(mm) if mm else None

        segments.append({
            "model": mname.group(1).strip(),
            "input_tokens": _num(cells[1]),
            "output_tokens": _num(cells[2]),
            "cache_tokens": _num(cells[3]),
            "total_tokens": _num(cells[4]),
            "hypercredits": _num(cells[5]),
            "cost_usd": _num(cells[6]),
        })
    if segments:
        res["segments"] = segments
    return res


def parse(raw) -> dict:
    """Pure function of the credits JSON text -> {tier, windows, segments, _hyper}."""
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable hyper response")
    if not data or not isinstance(data, dict):
        raise AuthExpiredError("unparseable hyper response")

    if data.get("error"):
        err = data["error"]
        if err.get("type") == "authentication_error":
            raise AuthExpiredError(err.get("message") or "invalid hyper API key")
        raise RuntimeError(f"hyper API error: {err.get('message') or json.dumps(err)}")

    balance = data.get("balance")
    if not isinstance(balance, (int, float)) or isinstance(balance, bool):
        raise AuthExpiredError("no usable hypercredits balance")

    used = max(0, PLAN_CAP - balance)
    pct = max(0, min(100, (100 * used) / PLAN_CAP))

    windows = [
        {
            "id": "hypercredits",
            "label": "Credits",
            "letter": "Hc",
            "pct": pct,
            "used": used,
            "cap": PLAN_CAP,
            "unit": "credits",
            "resets_at": None,  # filled in from the dashboard, best-effort
            "color": CREDITS_COLOR,
            "will_deplete": False,
        }
    ]
    return {
        "tier": "free",
        "windows": windows,
        "segments": [],
        "_hyper": {"balance": balance},
    }


def create_provider(client=None):
    st = {
        "apiKey": None,
        "cookie": None,
        "client": client,
        "dashboard_url": DASHBOARD_URL,
    }

    def config():
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": DASHBOARD_URL,
            "auth": {"kind": "token"},
            "windows": [
                {"id": "hypercredits", "label": "Credits", "color": CREDITS_COLOR}
            ],
            "tiers": ["free", "shred"],
        }

    def configure(cfg: dict | None = None):
        cfg = cfg or {}
        if "api_key" in cfg:
            st["apiKey"] = cfg["api_key"].strip() if cfg["api_key"] else None
        if "api_token" in cfg:
            st["apiKey"] = cfg["api_token"].strip() if cfg["api_token"] else None
        if "token" in cfg:
            st["apiKey"] = cfg["token"].strip() if cfg["token"] else st["apiKey"]
        if "cookie" in cfg:
            st["cookie"] = cfg["cookie"]

    async def set_auth(payload: str) -> None:
        st["apiKey"] = (payload or "").strip() or None

    async def fetch() -> str:
        if not st["apiKey"]:
            raise AuthExpiredError("no hyper API key configured")
        c = st["client"] or create_client()
        res = await c.get(
            CREDITS_URL,
            headers={
                "Authorization": f"Bearer {st['apiKey']}",
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
            },
        )
        if res.status_code in (401, 403):
            raise AuthExpiredError()
        if res.status_code == 429:
            ra = res.headers.get("retry-after")
            raise RateLimitedError(int(ra) if ra and ra.isdigit() else None)
        if res.status_code >= 400:
            raise RuntimeError(f"hyper.charm.land HTTP {res.status_code}")
        return res.text

    async def fetch_dashboard() -> str:
        """Best-effort dashboard fetch (cookie); '' if unreachable/unauthed."""
        if not st["cookie"]:
            return ""
        c = st["client"] or create_client()
        try:
            res = await c.get(
                st["dashboard_url"],
                headers={
                    "Cookie": st["cookie"],
                    "User-Agent": BROWSER_UA,
                    "Accept": "text/html",
                },
            )
            return res.text if res.status_code < 400 else ""
        except Exception:
            return ""

    def interval_seconds():
        return 300

    return {
        "id": ID,
        "label": LABEL,
        "auth": {"kind": "token"},
        "config": config,
        "configure": configure,
        "set_auth": set_auth,
        "fetch": fetch,
        "fetch_dashboard": fetch_dashboard,
        "parse_dashboard": parse_dashboard,
        "interval_seconds": interval_seconds,
        "parse": parse,
    }