"""Cohere usage provider plugin (port of src/providers/cohere.js, extended per
the locked data model).

Cohere's public API has no usage/quota endpoint. The dashboard "Usage" tab calls
an internal RPC:

  POST https://production.api.os.cohere.com/rpc/BlobheartAPI/GetAPIUsage
    Authorization: Bearer <dashboard session JWT>
    body: { req: { orgID, before, after, includeTotal: true } }
    -> { usages: [{ productID, productName, productUnit, quantity, time, total }] }

This is a per-model/per-day token ledger. LOCKED extensions over the JS:
  - tokens window over a trailing month bucket (WINDOW_DAYS=30, matches both the
    JS code and the live dashboard request Aug 5 -> Sep 5).
  - NEW `calls` window read from the RESPONSE HEADERS:
      x-ratelimit-limit: 300, x-ratelimit-remaining, x-ratelimit-reset
    used = limit - remaining, cap = limit, pct = used/cap. This is the real
    quota the JS ignored.
  - per-model segments parsed out of productName ("... on <Model> model").
  - meta gains a per-day burn curve + rate-limit state.

Auth is a pasted dashboard session JWT (~5-day lifespan), not a browser cookie —
cookie_from_firefox cannot recover it.
"""

from __future__ import annotations

import json
import re

from ..errors import AuthExpiredError
from ..httputil import create_client


TOKENS_COLOR = "#D55E00"
CALLS_COLOR = "#D55E00"

ID = "cohere"
LABEL = "Cohere"

USAGE_URL = "https://production.api.os.cohere.com/rpc/BlobheartAPI/GetAPIUsage"
USER_AGENT = "usage-daemon"
WINDOW_DAYS = 30

_RE_MODEL = re.compile(r"on (?:default )?(.+?) model", re.I)


def _parse_model(product_name: str) -> str:
    m = _RE_MODEL.search(product_name or "")
    return m.group(1).strip() if m else product_name


def _calls_window(headers):
    def _h(name: str):
        if not headers:
            return None
        v = headers.get(name) or headers.get(name.lower()) or headers.get(name.title())
        return v

    limit = _h("x-ratelimit-limit")
    remaining = _h("x-ratelimit-remaining")
    reset = _h("x-ratelimit-reset")
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = None
    try:
        remaining = int(remaining)
    except (TypeError, ValueError):
        remaining = None
    if limit is None or remaining is None:
        return None
    used = max(0, limit - remaining)
    return {
        "id": "calls",
        "label": "Calls",
        "letter": "Ca",
        "pct": (100 * used) / limit,
        "used": used,
        "cap": limit,
        "unit": "calls",
        "resets_at": reset,  # epoch seconds; runner's to_host_iso renders it
        "color": CALLS_COLOR,
        "will_deplete": False,
    }


def parse(raw, headers: dict | None = None) -> dict:
    """Pure function of the envelope JSON text (+ optional response headers)."""
    try:
        env = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable cohere usage envelope")
    if not env or not isinstance(env, dict) or not isinstance(env.get("usages"), list):
        raise AuthExpiredError("unparseable cohere usage envelope")

    input_tokens = 0
    output_tokens = 0
    per_model: dict[str, dict] = {}
    daily: dict[str, dict] = {}
    for u in env["usages"]:
        qty = u.get("quantity") if isinstance(u.get("quantity"), (int, float)) else 0
        unit = u.get("productUnit")
        if unit == "Input tokens":
            input_tokens += qty
        elif unit == "Output tokens":
            output_tokens += qty
        model = _parse_model(u.get("productName"))
        pm = per_model.setdefault(
            model, {"model": model, "input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        )
        key = "input_tokens" if unit == "Input tokens" else ("output_tokens" if unit == "Output tokens" else None)
        if key:
            pm[key] += qty
            pm["total_tokens"] = pm["input_tokens"] + pm["output_tokens"]
        day = (u.get("time") or "")[:10]
        if day:
            d = daily.setdefault(day, {"date": day, "input": 0, "output": 0, "total": 0})
            if key == "input_tokens":
                d["input"] += qty
            elif key == "output_tokens":
                d["output"] += qty
            d["total"] = d["input"] + d["output"]

    total_tokens = input_tokens + output_tokens
    windows = [
        {
            "id": "tokens",
            "label": f"Tokens ({WINDOW_DAYS}d)",
            "letter": "Tk",
            "pct": None,  # informational — no quota cap for token volume
            "used": total_tokens,
            "cap": None,
            "unit": "tokens",
            "resets_at": None,  # rolling window — the API exposes no reset date
            "color": TOKENS_COLOR,
            "will_deplete": False,
        }
    ]
    calls = _calls_window(headers)
    if calls:
        windows.append(calls)

    return {
        "tier": None,
        "windows": windows,
        "segments": sorted(per_model.values(), key=lambda s: -s["total_tokens"]),
        "_cohere": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens,
            "daily": sorted(daily.values(), key=lambda d: d["date"]),
            "rate_limit": (
                {"limit": calls["cap"], "remaining": calls["cap"] - calls["used"], "reset_at": calls["resets_at"]}
                if calls
                else None
            ),
        },
    }


def create_provider(client=None):
    st = {"token": None, "orgId": None, "lastHeaders": None, "client": client}

    def config():
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://dashboard.cohere.com/usage",
            "auth": {
                "kind": "token",
                "relogin": "re-paste dashboard session JWT (~5d lifespan)",
            },
            "category": "support",
            "windows": [
                {"id": "tokens", "label": f"Tokens ({WINDOW_DAYS}d)", "color": TOKENS_COLOR},
                {"id": "calls", "label": "Calls", "color": CALLS_COLOR},
            ],
            "tiers": [],
        }

    def configure(cfg: dict | None = None):
        cfg = cfg or {}
        if "api_token" in cfg:
            st["token"] = cfg["api_token"].strip() if cfg["api_token"] else None
        if "org_id" in cfg:
            st["orgId"] = cfg["org_id"].strip() if cfg["org_id"] else None

    async def set_auth(payload: str) -> None:
        st["token"] = (payload or "").strip() or None

    async def fetch() -> str:
        if not st["token"]:
            raise AuthExpiredError("no Cohere dashboard session token configured")
        if not st["orgId"]:
            raise RuntimeError("cohere: no org_id configured (see config.example.toml)")

        from datetime import datetime, timedelta, timezone

        now = datetime.now(timezone.utc)
        after = now - timedelta(days=WINDOW_DAYS)
        body = json.dumps({
            "req": {
                "orgID": st["orgId"],
                "before": now.isoformat(),
                "after": after.isoformat(),
                "includeTotal": True,
            }
        })
        c = st["client"] or create_client()
        res = await c.post(
            USAGE_URL,
            headers={
                "Authorization": f"Bearer {st['token']}",
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
                "Accept": "*/*",
                "Request-Source": "playground",
                "Origin": "https://dashboard.cohere.com",
                "Referer": "https://dashboard.cohere.com/",
            },
            content=body,
        )
        if res.status_code in (401, 403):
            raise AuthExpiredError()
        if res.status_code == 429:
            from ..errors import RateLimitedError

            ra = res.headers.get("retry-after")
            raise RateLimitedError(int(ra) if ra and ra.isdigit() else None)
        if res.status_code >= 400:
            raise RuntimeError(f"production.api.os.cohere.com HTTP {res.status_code}")
        st["lastHeaders"] = dict(res.headers)
        return res.text

    def parse_fn(raw):
        return parse(raw, headers=st["lastHeaders"])

    def interval_seconds():
        return 900  # billing ledger — poll less often than a live quota

    def meta():
        # parse_fn() is where the runner gets the stats; surface a static label
        # hint so clients know the ledger's window without re-fetching.
        return {"window_days": WINDOW_DAYS}

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
        "parse": parse_fn,
    }