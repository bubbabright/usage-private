"""Cloudflare Workers AI usage provider (port of src/providers/cloudflare.js).

Daily neuron quota (like claude's rolling windows, not a spend/credit balance):
every account gets 10,000 free Neurons/day, reset 00:00 UTC. Above that,
Workers Paid bills overage at $0.011/1k with no cap — so pct CAN exceed 100
("in overage, still billing"); we do NOT clamp the top, only the floor.

Source: the GraphQL Analytics API,
  POST https://api.cloudflare.com/client/v4/graphql
  viewer.accounts(filter:{accountTag}).aiInferenceAdaptiveGroups
grouped by (date, modelId); sum.totalNeurons per row. Auth: API token as Bearer
(the token `wrangler login` mints is sufficient). Daemon reads the token from
config; never writes it.

parse() is a PURE function of the GraphQL response JSON text so it unit-tests
against a vendored real capture with no network.
"""

from __future__ import annotations

import datetime as _dt
import json

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

NEURONS_COLOR = "#E69F00"  # Okabe-Ito orange

ID = "cloudflare"
LABEL = "Cloudflare AI"

FREE_NEURONS_PER_DAY = 10000
GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql"
USER_AGENT = "usage-daemon/0.1"

# One grouped query for a single UTC day. accountTag + date bound at call time.
QUERY = (
    "query($acct:String!,$d:Date!){viewer{accounts(filter:{accountTag:$acct})"
    "{aiInferenceAdaptiveGroups(limit:1000,filter:{date_geq:$d,date_leq:$d},orderBy:[date_DESC])"
    "{count sum{totalNeurons} dimensions{date modelId}}}}}"
)


def next_utc_midnight(from_dt: _dt.datetime | None = None) -> str:
    """Next 00:00 UTC — the daily neuron quota's fixed reset boundary."""
    d = from_dt or _dt.datetime.now(_dt.timezone.utc)
    nxt = _dt.datetime(d.year, d.month, d.day, tzinfo=_dt.timezone.utc) + _dt.timedelta(days=1)
    return nxt.strftime("%Y-%m-%dT%H:%M:%SZ")


# Pure function of the GraphQL response JSON text — no fs/network.
def parse(raw) -> dict:
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable cloudflare graphql response")

    if not isinstance(data, dict):
        raise AuthExpiredError("unparseable cloudflare graphql response")

    # GraphQL surfaces auth/permission failures in `errors` with data:null.
    errors = data.get("errors")
    if errors and data.get("data") is None:
        first = errors[0] if isinstance(errors[0], dict) else {}
        msg = first.get("message") or "graphql error"
        if (first.get("extensions") or {}).get("code") == "quota":
            raise RateLimitedError()
        raise AuthExpiredError(f"cloudflare graphql: {msg}")

    accounts = ((data.get("data") or {}).get("viewer") or {}).get("accounts")
    if not isinstance(accounts, list) or len(accounts) == 0:
        # No account matched the tag -> bad token/accountTag, treat as auth.
        raise AuthExpiredError("cloudflare graphql returned no account")

    groups = accounts[0].get("aiInferenceAdaptiveGroups") if isinstance(accounts[0], dict) else None
    groups = groups if isinstance(groups, list) else []
    # Empty groups is VALID — it means zero AI usage today, not an error.
    total_neurons = 0.0
    per_model: dict[str, float] = {}
    for g in groups:
        n = (g or {}).get("sum", {}).get("totalNeurons") if isinstance(g, dict) else None
        if isinstance(n, (int, float)) and not isinstance(n, bool):
            total_neurons += n
            model = ((g.get("dimensions") or {}).get("modelId")) if isinstance(g, dict) else None
            if model:
                per_model[model] = per_model.get(model, 0) + n

    # Floor-clamp only: overage past 100% is real signal on Workers Paid.
    pct = max(0.0, (100 * total_neurons) / FREE_NEURONS_PER_DAY)

    windows = [
        {
            "id": "daily_neurons",
            "label": "Neurons",
            "letter": "Ne",
            "pct": pct,
            # Absolute usage alongside pct: neurons are a real countable unit
            # against a hard daily cap, so clients can show "73 / 10000 neurons".
            "used": total_neurons,
            "cap": FREE_NEURONS_PER_DAY,
            "unit": "neurons",
            "resets_at": next_utc_midnight(),
            "color": NEURONS_COLOR,
            "will_deplete": False,
        }
    ]

    segments = [
        {"model": model, "neurons": neurons}
        for model, neurons in sorted(per_model.items(), key=lambda kv: -kv[1])
    ]

    return {"tier": None, "windows": windows, "segments": segments}


def create() -> dict:
    state = {"api_token": None, "account_id": None}

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://dash.cloudflare.com",
            "auth": {"kind": "token"},
            "windows": [{"id": "daily_neurons", "label": "Neurons", "color": NEURONS_COLOR}],
            "tiers": [],
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        # "in cfg" so configure({'api_token': ''}) can explicitly clear it.
        if "api_token" in cfg:
            state["api_token"] = str(cfg["api_token"]).strip() if cfg["api_token"] else None
        if "token" in cfg and cfg["token"]:
            state["api_token"] = str(cfg["token"]).strip()
        if cfg.get("account_id"):
            state["account_id"] = str(cfg["account_id"]).strip()
        if cfg.get("account_tag"):
            state["account_id"] = str(cfg["account_tag"]).strip()

    async def set_auth(payload: str) -> None:
        state["api_token"] = str(payload or "").strip() or None

    async def fetch() -> str:
        if not state["api_token"]:
            raise AuthExpiredError("no Cloudflare API token configured")
        if not state["account_id"]:
            raise AuthExpiredError("no Cloudflare account_id configured")

        today = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d")  # UTC date
        c = create_client()
        try:
            res = await c.post(
                GRAPHQL_URL,
                headers={
                    "Authorization": f"Bearer {state['api_token']}",
                    "Content-Type": "application/json",
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                },
                content=json.dumps(
                    {"query": QUERY, "variables": {"acct": state["account_id"], "d": today}}
                ),
            )
        finally:
            await c.aclose()
        if res.status_code in (401, 403):
            raise AuthExpiredError()
        if res.status_code == 429:
            ra = res.headers.get("retry-after")
            raise RateLimitedError(float(ra) if ra and ra.replace(".", "", 1).isdigit() else None)
        if res.status_code >= 400:
            raise RuntimeError(f"api.cloudflare.com HTTP {res.status_code}")
        return res.text

    return {
        "id": ID,
        "label": LABEL,
        "auth": {"kind": "token"},
        "config": config,
        "configure": configure,
        "set_auth": set_auth,
        "fetch": fetch,
        "interval_seconds": lambda: 300,
        "meta": lambda: {},
        "parse": parse,
    }
