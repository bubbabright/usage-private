"""GitHub usage provider plugin (port of src/providers/github.js).

REST/GraphQL/search API call budget from GET /rate_limit with a PAT. Measures
API call budget only — not Copilot/Actions consumption (separate billing
endpoints, not covered yet). used carries remaining calls with
used_is_remaining: true, mirroring the JS.
"""

from __future__ import annotations

import datetime as _dt
import json

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

CORE_COLOR = "#0072B2"  # Okabe-Ito blue
SEARCH_COLOR = "#E69F00"  # Okabe-Ito orange
GRAPHQL_COLOR = "#CC79A7"  # Okabe-Ito reddish-purple

ID = "github"
LABEL = "GitHub"

API_URL = "https://api.github.com"
RATE_LIMIT_PATH = "/rate_limit"
USER_AGENT = "usage-daemon/0.1"
API_VERSION = "2022-11-28"


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _window_for(id, label, letter, color, resource) -> dict | None:
    if not resource or not _num(resource.get("limit")) or not _num(resource.get("remaining")):
        return None
    return {
        "id": id,
        "label": label,
        "letter": letter,
        "pct": max(0, min(100, (100 * (resource["limit"] - resource["remaining"])) / resource["limit"]))
        if resource["limit"] > 0
        else None,
        "used": resource["remaining"],  # remaining calls, not consumed
        "used_is_remaining": True,
        "cap": resource["limit"],
        "unit": "calls",
        "resets_at": _dt.datetime.fromtimestamp(resource["reset"], _dt.timezone.utc).isoformat()
        if _num(resource.get("reset"))
        else None,
        "color": color,
        "will_deplete": False,
    }


def _load(raw):
    try:
        env = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable GitHub rate_limit response")
    if not isinstance(env, dict):
        raise AuthExpiredError("unparseable GitHub rate_limit response")
    return env


def parse(raw) -> dict:
    """Pure function of the raw JSON text — no fs/network."""
    env = _load(raw)
    if not env.get("resources"):
        raise AuthExpiredError("no usable GitHub rate_limit figures")

    windows = [
        w
        for w in (
            _window_for("core", "REST Calls", "Rc", CORE_COLOR, env["resources"].get("core")),
            _window_for("search", "Search Calls", "Sr", SEARCH_COLOR, env["resources"].get("search")),
            _window_for("graphql", "GraphQL Calls", "Gq", GRAPHQL_COLOR, env["resources"].get("graphql")),
        )
        if w is not None
    ]
    if not windows:
        raise AuthExpiredError("no usable GitHub rate_limit figures")

    core = env["resources"].get("core") or {}
    return {
        "tier": None,
        "windows": windows,
        "segments": [],
        # carried out of parse so meta() can surface the raw figures too.
        "_github": {
            "core_remaining": core.get("remaining") if _num(core.get("remaining")) else None,
            "core_limit": core.get("limit") if _num(core.get("limit")) else None,
        },
    }


def create() -> dict:
    state = {"api_key": None, "last_stats": None}

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://github.com/settings/tokens",
            "auth": {"kind": "token"},
            "category": "support",
            "windows": [{"id": "core", "label": "REST Calls", "color": CORE_COLOR}],
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
            raise AuthExpiredError("no GitHub API token configured")

        c = create_client()
        try:
            res = await c.get(
                f"{API_URL}{RATE_LIMIT_PATH}",
                headers={
                    "Authorization": f"Bearer {state['api_key']}",
                    "User-Agent": USER_AGENT,
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": API_VERSION,
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
            raise RuntimeError(f"api.github.com HTTP {res.status_code}")

        body = res.json()
        state["last_stats"] = parse(json.dumps(body))["_github"]
        return json.dumps(body)

    def interval_seconds() -> int:
        return 300

    def meta() -> dict:
        s = state["last_stats"]
        if not s:
            return {}
        return {"core_remaining": s["core_remaining"], "core_limit": s["core_limit"]}

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
