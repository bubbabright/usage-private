"""RunPod usage provider plugin (port of src/providers/runpod.js).

RunPod's balance figure is GraphQL-only (REST billing reports historical line
items, not a current balance): POST /graphql?api_key=<key> with a `myself`
query. clientBalance is pay-as-you-go dollars — no cap/reset — rendered as a
bare "balance remaining" meter (used_is_remaining: true), like serpapi.
"""

from __future__ import annotations

import json
from urllib.parse import quote

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

BALANCE_COLOR = "#009E73"  # Okabe-Ito green

ID = "runpod"
LABEL = "RunPod"

GRAPHQL_URL = "https://api.runpod.io/graphql"
USER_AGENT = "usage-daemon/0.1"
QUERY = "query myself { myself { clientBalance underBalance minBalance } }"


def _load(raw):
    try:
        env = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable RunPod graphql envelope")
    if not isinstance(env, dict):
        raise AuthExpiredError("unparseable RunPod graphql envelope")
    return env


def parse(raw) -> dict:
    """Pure function of the raw JSON text — no fs/network."""
    env = _load(raw)
    if env.get("errors"):
        msg = (env["errors"][0] or {}).get("message") if env["errors"] else None
        raise AuthExpiredError(f"runpod: {msg or 'graphql error'}")

    me = (env.get("data") or {}).get("myself")
    if not me or not isinstance(me.get("clientBalance"), (int, float)) or isinstance(me.get("clientBalance"), bool):
        raise AuthExpiredError("no usable RunPod balance in graphql response")

    windows = [
        {
            "id": "balance",
            "label": "Balance",
            "letter": "Bl",
            "pct": None,  # pay-as-you-go dollar balance, no fixed cap
            "used": me["clientBalance"],
            "used_is_remaining": True,
            "unit": "USD",
            "resets_at": None,
            "color": BALANCE_COLOR,
            "will_deplete": me.get("underBalance") is True,
        }
    ]
    return {
        "tier": None,
        "windows": windows,
        "segments": [],
        # carried out of parse so meta() can surface the raw figures too.
        "_runpod": {
            "client_balance": me["clientBalance"],
            "under_balance": me.get("underBalance") if me.get("underBalance") is not None else None,
            "min_balance": me["minBalance"] if isinstance(me.get("minBalance"), (int, float)) and not isinstance(me.get("minBalance"), bool) else None,
        },
    }


def create() -> dict:
    state = {"api_key": None, "last_stats": None}

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://www.runpod.io/console/user/billing",
            "auth": {"kind": "token"},
            "category": "support",
            "windows": [{"id": "balance", "label": "Balance", "color": BALANCE_COLOR}],
            "tiers": [],
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        if "api_key" in cfg:
            state["api_key"] = str(cfg["api_key"]).strip() if cfg["api_key"] else None

    async def set_auth(payload: str) -> None:
        state["api_key"] = str(payload or "").strip() or None

    async def fetch() -> str:
        if not state["api_key"]:
            raise AuthExpiredError("no RunPod API key configured")

        c = create_client()
        try:
            res = await c.post(
                f"{GRAPHQL_URL}?api_key={quote(state['api_key'], safe='')}",
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                },
                content=json.dumps({"query": QUERY}),
            )
        finally:
            await c.aclose()

        if res.status_code in (401, 403):
            raise AuthExpiredError()
        if res.status_code == 429:
            ra = res.headers.get("retry-after")
            raise RateLimitedError(int(ra) if ra and ra.isdigit() else None)
        if res.status_code >= 400:
            raise RuntimeError(f"api.runpod.io HTTP {res.status_code}")

        body = res.json()
        if body and body.get("errors"):
            msg = (body["errors"][0] or {}).get("message") if body["errors"] else None
            raise AuthExpiredError(f"runpod: {msg or 'graphql error'}")
        state["last_stats"] = parse(json.dumps(body))["_runpod"]
        return json.dumps(body)

    def interval_seconds() -> int:
        return 300

    def meta() -> dict:
        s = state["last_stats"]
        if not s:
            return {}
        return {
            "client_balance": s["client_balance"],
            "under_balance": s["under_balance"],
            "min_balance": s["min_balance"],
        }

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
