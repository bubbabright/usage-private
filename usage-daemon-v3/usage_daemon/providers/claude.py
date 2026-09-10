"""Claude Code usage provider plugin (port of src/providers/claude.js).

Reads the OAuth usage endpoint with the same accessToken the `claude` CLI uses
(`~/.claude/.credentials.json`). In practice this host may also carry a raw
bearer token in that path; accept either shape so a fresh v3 process can use
what the live environment already has on disk. READ-ONLY: never mutates the
token — an expired/missing one just reports auth_expired; `claude login` is the
mutator.

The claude-code/<version> User-Agent gates real 429s: Anthropic buckets UAs too
far behind the current CLI. Resolution: config override > detected
`claude --version` > hardcoded fallback (FALLBACK_CLAUDE_VERSION).
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import json
import os
import re
import shutil
from pathlib import Path

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

SESSION_COLOR = "#E69F00"
WEEKLY_COLOR = "#56B4E9"
EXTRA_COLOR = "#009E73"

ID = "claude"
LABEL = "Claude Code"

API_URL = "https://api.anthropic.com/api/oauth/usage"
FALLBACK_CLAUDE_VERSION = "2.1.220"
CLAUDE_UA_PREFIX = "claude-code/"


def extract_version(s) -> str | None:
    m = re.search(r"(\d+\.\d+\.\d+)", s or "")
    return m.group(1) if m else None


def _default_credentials_path() -> str:
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(
        os.path.expanduser("~"), ".claude"
    )
    return os.path.join(cfg, ".credentials.json")


def next_month_start(from_dt=None) -> str:
    """First of next month, 00:00 UTC — extra-usage monthly cap reset boundary."""
    d = from_dt or _dt.datetime.now(_dt.timezone.utc)
    if d.tzinfo is None:
        d = d.replace(tzinfo=_dt.timezone.utc)
    y, m = d.year, d.month
    nm = _dt.datetime(
        y + (1 if m == 12 else 0),
        1 if m == 12 else m + 1,
        1,
        tzinfo=_dt.timezone.utc,
    )
    return nm.isoformat()


def parse(raw) -> dict:
    """Pure function of the raw API JSON text -> {tier, windows, segments}."""
    try:
        data = json.loads(raw)
    except Exception:
        raise AuthExpiredError("unparseable usage response")
    if not data.get("five_hour") or not data.get("seven_day"):
        raise AuthExpiredError()

    five = data["five_hour"]
    seven = data["seven_day"]
    windows = [
        {
            "id": "session",
            "label": "5h",
            "letter": "5h",
            "pct": five.get("utilization"),
            "resets_at": five.get("resets_at"),
            "color": SESSION_COLOR,
            "will_deplete": False,
        },
        {
            "id": "weekly",
            "label": "7d",
            "letter": "Wk",
            "pct": seven.get("utilization"),
            "resets_at": seven.get("resets_at"),
            "color": WEEKLY_COLOR,
            "will_deplete": False,
        },
    ]

    eu = data.get("extra_usage")
    if eu and eu.get("is_enabled"):
        dp = eu["decimal_places"] if isinstance(eu.get("decimal_places"), (int, float)) else 2
        div = 10 ** int(dp)
        used = (
            eu["used_credits"] / div
            if isinstance(eu.get("used_credits"), (int, float))
            else None
        )
        cap = (
            eu["monthly_limit"] / div
            if isinstance(eu.get("monthly_limit"), (int, float))
            else None
        )
        if isinstance(eu.get("utilization"), (int, float)):
            pct = eu["utilization"]
        elif cap and cap > 0 and used is not None:
            pct = (100 * used) / cap
        else:
            pct = None
        windows.append({
            "id": "extra_usage",
            "label": "Usage Credits",
            "letter": "Cr",
            "pct": pct,
            "used": used,
            "cap": cap,
            "unit": eu.get("currency") or "USD",
            "resets_at": next_month_start(),
            "color": EXTRA_COLOR,
            "will_deplete": False,
        })

    return {"tier": None, "windows": windows, "segments": []}


async def _detect_cli_version_once(cache: dict) -> str | None:
    """Detect the installed CLI version once; cache the result for concurrent polls."""
    if "done" in cache:
        return cache.get("value")
    cache["done"] = True
    cli = shutil.which("claude")
    if cli is None:
        cache["value"] = None
        return None
    proc = await asyncio.create_subprocess_exec(
        cli,
        "--version",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
    except Exception:
        cache["value"] = None
        return None
    cache["value"] = extract_version(out.decode("utf-8", "replace"))
    return cache["value"]


def create_provider(credentials_path: str | None = None, client=None):
    st = {
        "credentialsPath": credentials_path or _default_credentials_path(),
        "lastTokenExpiresAt": None,
        "configuredVersion": None,
        "resolvedUserAgent": None,
        "client": client,
        "detectCache": {},
    }

    def config():
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://claude.ai/settings/usage",
            "auth": {
                "kind": "oauth-file",
                "path": st["credentialsPath"],
                "relogin": "claude  (then /login)",
            },
            "windows": [
                {"id": "session", "label": "5h", "color": SESSION_COLOR},
                {"id": "weekly", "label": "7d", "color": WEEKLY_COLOR},
                {"id": "extra_usage", "label": "Usage Credits", "color": EXTRA_COLOR},
            ],
            "tiers": [],
        }

    def configure(cfg: dict | None = None):
        cfg = cfg or {}
        p = cfg.get("credentialsPath") or cfg.get("credentials_path")
        if p:
            st["credentialsPath"] = p
        v = extract_version(cfg.get("user_agent_version") or cfg.get("userAgentVersion"))
        if v:
            st["configuredVersion"] = v
            st["resolvedUserAgent"] = None

    async def set_auth(payload: str) -> None:
        path = Path(st["credentialsPath"])
        await asyncio.to_thread(path.parent.mkdir, exist_ok=True, parents=True)

        def _write():
            path.write_text(payload + "\n", encoding="utf-8")
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass

        await asyncio.to_thread(_write)

    async def _resolve_user_agent() -> str:
        if st["resolvedUserAgent"]:
            return st["resolvedUserAgent"]
        v = (
            st["configuredVersion"]
            or await _detect_cli_version_once(st["detectCache"])
            or FALLBACK_CLAUDE_VERSION
        )
        st["resolvedUserAgent"] = CLAUDE_UA_PREFIX + v
        return st["resolvedUserAgent"]

    async def fetch() -> str:
        def _read():
            try:
                return Path(st["credentialsPath"]).read_text(encoding="utf-8")
            except OSError:
                return None

        raw = await asyncio.to_thread(_read)
        if raw is None:
            raise AuthExpiredError("no Claude Code credentials file found")
        text = raw.strip()
        access_token = None
        st["lastTokenExpiresAt"] = None
        try:
            j = json.loads(text)
        except Exception:
            # Practical compatibility: some local setups store the bearer token
            # directly in this path instead of the CLI's JSON envelope.
            access_token = text or None
        else:
            access_token = (j or {}).get("claudeAiOauth", {}).get("accessToken")
            st["lastTokenExpiresAt"] = (j or {}).get("claudeAiOauth", {}).get("expiresAt")
        if not access_token:
            raise AuthExpiredError("no accessToken in credentials file")

        c = st["client"] or create_client()
        res = await c.get(
            API_URL,
            headers={
                "Authorization": f"Bearer {access_token}",
                "anthropic-beta": "oauth-2025-04-20",
                "User-Agent": await _resolve_user_agent(),
            },
        )
        if res.status_code in (401, 403):
            detail = None
            try:
                err = res.json().get("error") or {}
                detail = err.get("message")
                scopes = ((err.get("details") or {}).get("required_scopes"))
                if isinstance(scopes, list) and scopes:
                    detail = f"{detail or 'OAuth token rejected'} (required scopes: {', '.join(map(str, scopes))})"
            except Exception:
                detail = None
            raise AuthExpiredError(detail or "Claude Code token missing, expired, or insufficiently scoped")
        if res.status_code == 429:
            ra = res.headers.get("retry-after")
            raise RateLimitedError(int(ra) if ra and ra.isdigit() else None)
        if res.status_code >= 400:
            raise RuntimeError(f"api.anthropic.com HTTP {res.status_code}")
        return res.text

    def interval_seconds():
        return 300

    def meta():
        return {"token_expires_at": st["lastTokenExpiresAt"]}

    return {
        "id": ID,
        "label": LABEL,
        "auth": {"kind": "oauth-file"},
        "config": config,
        "configure": configure,
        "set_auth": set_auth,
        "fetch": fetch,
        "interval_seconds": interval_seconds,
        "meta": meta,
        "parse": parse,
    }