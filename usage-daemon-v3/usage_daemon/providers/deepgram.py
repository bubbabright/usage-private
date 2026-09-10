"""Deepgram usage provider (port of src/providers/deepgram.js).

Deepgram is pay-as-you-go against a PREPAID balance (dollars), not a rolling
time-window and not a hard daily cap. The headroom that matters is "how many
dollars are left", so this plugin reads the balances endpoint:
  GET https://api.deepgram.com/v1/projects            (discover projects)
  GET https://api.deepgram.com/v1/projects/{id}/balances
    -> { balances: [ { balance_id, amount, units, purchase_order_id } ] }
amount is remaining USD. Sum across a project's balances (and across all
visible projects when no project_id is pinned).

A prepaid balance has no reset and no intrinsic ceiling, so pct is only
meaningful against a user-declared starting credit (`balance_cap` in config).
Without a cap we still surface the dollar figure via meta() and leave pct
null (a balance meter, not a percentage bar) — the known "balance meter kind"
gap, shared with openrouter credits.

Auth: `Authorization: Token <API_KEY>`; the key needs the `usage:read` scope.
parse() is a PURE function of the envelope JSON text.
"""

from __future__ import annotations

import json

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

BALANCE_COLOR = "#009E73"  # Okabe-Ito green

ID = "deepgram"
LABEL = "Deepgram"

BASE_URL = "https://api.deepgram.com/v1"
USER_AGENT = "usage-daemon/0.1"


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


# Pure function of the envelope JSON text — no fs/network.
# envelope: { balances: [{amount, units}], projects: <int>, cap: <number|null> }
def parse(raw) -> dict:
    try:
        env = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable deepgram envelope")
    if not isinstance(env, dict):
        raise AuthExpiredError("unparseable deepgram envelope")
    # Deepgram surfaces auth/scope failures as { err_code, err_msg }.
    if env.get("err_code"):
        raise AuthExpiredError(f"deepgram: {env.get('err_msg') or env.get('err_code')}")
    if not isinstance(env.get("balances"), list):
        raise AuthExpiredError("deepgram returned no balances")

    remaining = 0
    units = "USD"
    for b in env["balances"]:
        if isinstance(b, dict) and _num(b.get("amount")):
            remaining += b["amount"]
            if isinstance(b.get("units"), str) and b["units"]:
                units = b["units"]

    cap = env.get("cap") if _num(env.get("cap")) and env["cap"] > 0 else None
    # Used-% only when the user declared a starting credit; else balance meter.
    pct = max(0.0, min(100.0, (100 * (cap - remaining)) / cap)) if cap is not None else None

    windows = [
        {
            "id": "balance",
            "label": "Balance",
            "letter": "Bal",
            "pct": pct,
            # The dollars left have to ride on the WINDOW, not just in
            # _balance/meta(): without these a healthy provider rendered as an
            # empty bar with no number anywhere.
            "used": remaining,
            "used_is_remaining": True,
            "cap": cap,
            "unit": units,
            "resets_at": None,
            "color": BALANCE_COLOR,
            "will_deplete": False,
        }
    ]

    return {
        "tier": None,
        "windows": windows,
        "segments": [],
        # carried out of parse so meta() can surface the raw figures too.
        "_balance": {"amount": remaining, "units": units},
    }


def create() -> dict:
    state = {"api_key": None, "project_id": None, "cap": None, "last_balance": None}

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://console.deepgram.com",
            "auth": {"kind": "token"},
            # Support service (speech-to-text), not an AI plan: a metered API
            # that backs the work rather than being the work. Clients render
            # these compactly instead of giving them a full plan card.
            "category": "support",
            "windows": [{"id": "balance", "label": "Balance", "color": BALANCE_COLOR}],
            "tiers": [],
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        # "in cfg" so configure({'api_key': ''}) can explicitly clear it.
        if "api_key" in cfg:
            state["api_key"] = str(cfg["api_key"]).strip() if cfg["api_key"] else None
        if cfg.get("project_id"):
            state["project_id"] = str(cfg["project_id"]).strip()
        if "balance_cap" in cfg:
            n = cfg["balance_cap"]
            state["cap"] = n if _num(n) and n > 0 else None

    async def set_auth(payload: str) -> None:
        state["api_key"] = str(payload or "").strip() or None

    async def _get(url: str):
        c = create_client()
        try:
            return await c.get(
                url,
                headers={
                    "Authorization": f"Token {state['api_key']}",
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                },
            )
        finally:
            await c.aclose()

    def _guard(res, who: str) -> None:
        if res.status_code in (401, 403):
            raise AuthExpiredError()
        if res.status_code == 429:
            ra = res.headers.get("retry-after")
            raise RateLimitedError(float(ra) if ra and ra.replace(".", "", 1).isdigit() else None)
        if res.status_code >= 400:
            raise RuntimeError(f"{who} HTTP {res.status_code}")

    async def fetch() -> str:
        if not state["api_key"]:
            raise AuthExpiredError("no Deepgram API key configured")

        # Resolve which projects to query.
        if state["project_id"]:
            project_ids = [state["project_id"]]
        else:
            res = await _get(f"{BASE_URL}/projects")
            _guard(res, "api.deepgram.com/projects")
            body = res.json()
            project_ids = [
                p.get("project_id")
                for p in (body.get("projects") or [])
                if isinstance(p, dict) and p.get("project_id")
            ]
            if not project_ids:
                raise AuthExpiredError("Deepgram key sees no projects")

        # Sum balances across every project.
        balances = []
        for pid in project_ids:
            res = await _get(f"{BASE_URL}/projects/{pid}/balances")
            _guard(res, "api.deepgram.com/balances")
            body = res.json()
            if isinstance(body.get("balances"), list):
                balances.extend(body["balances"])

        envelope = {"balances": balances, "projects": len(project_ids), "cap": state["cap"]}
        # Cache the dollar figure for meta() (parse() computes it too, but the
        # runner calls meta() independently of parse()).
        parsed = parse(json.dumps(envelope))
        state["last_balance"] = parsed["_balance"]
        return json.dumps(envelope)

    def meta() -> dict:
        lb = state["last_balance"]
        return {"balance_usd": lb["amount"], "balance_units": lb["units"]} if lb else {}

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
