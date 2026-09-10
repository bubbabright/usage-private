"""Consensus usage provider plugin (port of src/providers/consensus.js).

Consensus exposes its counters via Clerk's client envelope. The visible caps are
free-tier UI constants, not API fields, so pct is computed against those known
caps only.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
from typing import Any

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

PRO_COLOR = "#E69F00"
DEEP_COLOR = "#56B4E9"
SNAPSHOT_COLOR = "#009E73"

ID = "consensus"
LABEL = "Consensus"

CLERK_URL = "https://clerk.consensus.app"
CLERK_API_VERSION = "2026-05-12"
CLERK_JS_VERSION = "6.29.2"
USER_AGENT = "usage-daemon/0.1"

FREE_PRO_CAP = 15
FREE_DEEP_CAP = 3
FREE_SNAPSHOT_CAP = 10
RESET_CYCLE_DAYS = 30


def _clamp_pct(n):
    if not isinstance(n, (int, float)) or isinstance(n, bool) or not math.isfinite(n):
        return None
    return max(0.0, min(100.0, float(n)))


def _add_days_iso(iso: str, days: int) -> str | None:
    try:
        dt = _dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except Exception:
        return None
    out = dt + _dt.timedelta(days=days)
    return out.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse(raw) -> dict:
    try:
        env = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable consensus/clerk envelope")
    if not isinstance(env, dict):
        raise AuthExpiredError("unparseable consensus/clerk envelope")

    sessions = None
    response = env.get("response")
    if isinstance(response, dict) and isinstance(response.get("sessions"), list):
        sessions = response.get("sessions")
    client = env.get("client")
    if sessions is None and isinstance(client, dict) and isinstance(client.get("sessions"), list):
        sessions = client.get("sessions")
    sessions = sessions or []

    session = next((s for s in sessions if isinstance(s, dict) and s.get("status") == "active"), None)
    if session is None and sessions:
        session = sessions[0] if isinstance(sessions[0], dict) else None
    meta = ((session or {}).get("user") or {}).get("public_metadata") if isinstance(session, dict) else None
    if not isinstance(meta, dict):
        raise AuthExpiredError("no active Consensus session in Clerk envelope")

    pro_used = len(meta["used_pro_search_queries"]) if isinstance(meta.get("used_pro_search_queries"), list) else None
    deep_used = len(meta["used_deep_search_queries"]) if isinstance(meta.get("used_deep_search_queries"), list) else None
    snapshot_used = (
        len(meta["used_consensus_snapshot_queries"])
        if isinstance(meta.get("used_consensus_snapshot_queries"), list)
        else None
    )
    if pro_used is None and deep_used is None and snapshot_used is None:
        raise AuthExpiredError("no usable Consensus query counters in public_metadata")

    last_reset_date = meta.get("last_reset_date")
    resets_at = _add_days_iso(last_reset_date, RESET_CYCLE_DAYS) if isinstance(last_reset_date, str) else None

    windows: list[dict] = []
    if pro_used is not None:
        windows.append({
            "id": "pro_messages",
            "label": "Pro Messages",
            "letter": "Pr",
            "pct": _clamp_pct((100 * pro_used) / FREE_PRO_CAP),
            "used": pro_used,
            "cap": FREE_PRO_CAP,
            "unit": "messages",
            "resets_at": resets_at,
            "color": PRO_COLOR,
            "will_deplete": False,
        })
    if deep_used is not None:
        windows.append({
            "id": "deep_reviews",
            "label": "Deep Reviews",
            "letter": "Dp",
            "pct": _clamp_pct((100 * deep_used) / FREE_DEEP_CAP),
            "used": deep_used,
            "cap": FREE_DEEP_CAP,
            "unit": "reviews",
            "resets_at": resets_at,
            "color": DEEP_COLOR,
            "will_deplete": False,
        })
    if snapshot_used is not None:
        windows.append({
            "id": "snapshots",
            "label": "Snapshots",
            "letter": "Sn",
            "pct": _clamp_pct((100 * snapshot_used) / FREE_SNAPSHOT_CAP),
            "used": snapshot_used,
            "cap": FREE_SNAPSHOT_CAP,
            "unit": "snapshots",
            "resets_at": resets_at,
            "color": SNAPSHOT_COLOR,
            "will_deplete": False,
        })

    return {
        "tier": None,
        "windows": windows,
        "segments": [],
        "_consensus": {
            "pro_used": pro_used,
            "deep_used": deep_used,
            "snapshot_used": snapshot_used,
            "last_reset_date": last_reset_date if isinstance(last_reset_date, str) else None,
        },
    }


def create() -> dict:
    state: dict[str, Any] = {"cookie": None, "last_stats": None}

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://consensus.app/settings/subscription/",
            "auth": {"kind": "cookie"},
            "category": "support",
            "windows": [
                {"id": "pro_messages", "label": "Pro Messages", "color": PRO_COLOR},
                {"id": "deep_reviews", "label": "Deep Reviews", "color": DEEP_COLOR},
                {"id": "snapshots", "label": "Snapshots", "color": SNAPSHOT_COLOR},
            ],
            "tiers": [],
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        if "cookie" in cfg:
            state["cookie"] = str(cfg["cookie"]).strip() if cfg["cookie"] else None

    async def fetch() -> str:
        if not state["cookie"]:
            raise AuthExpiredError("no Consensus session cookie configured")
        url = f"{CLERK_URL}/v1/client?__clerk_api_version={CLERK_API_VERSION}&_clerk_js_version={CLERK_JS_VERSION}"
        c = create_client()
        try:
            res = await c.get(
                url,
                headers={
                    "Cookie": state["cookie"],
                    "User-Agent": USER_AGENT,
                    "Accept": "*/*",
                    "Referer": "https://consensus.app/",
                    "Origin": "https://consensus.app",
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
            raise RuntimeError(f"clerk.consensus.app HTTP {res.status_code}")
        state["last_stats"] = parse(res.text)["_consensus"]
        return res.text

    def meta() -> dict:
        s = state["last_stats"]
        if not s:
            return {}
        return {
            "pro_used": s["pro_used"],
            "deep_used": s["deep_used"],
            "snapshot_used": s["snapshot_used"],
            "last_reset_date": s["last_reset_date"],
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
