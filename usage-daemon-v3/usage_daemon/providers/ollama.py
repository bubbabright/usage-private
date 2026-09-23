"""Ollama Cloud usage provider plugin (port of src/providers/ollama.js).

No JSON usage API — account usage is server-rendered HTML at
https://ollama.com/settings ("Usage" tab, htmx). Auth is the browser session
cookie, NOT the API key.

parse() is a PURE function of the page HTML so it unit-tests against the
vendored fixture (tests/fixtures/ollama-settings.html) with no network.
fetch() adds the fetch + auth-expiry detection around it.

Ollama redesigned this page 2026-09: the old "Cloud usage" heading with
separate "Session usage"/"Weekly usage" meters is gone, replaced by one
"Included usage" heading with a single "<tier> usage" meter (observed live
2026-09-09 against a real free-tier account — confirmed authenticated: HTTP
200, real usage data, no login redirect). The stale "Cloud usage" substring
check was misreading that redesigned-but-authenticated page as logged out.
"""

from __future__ import annotations

import re

USAGE_COLOR = "#E69F00"  # Okabe-Ito orange

ID = "ollama"
LABEL = "Ollama Cloud"

DEFAULT_URL = "https://ollama.com/settings"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) usage-daemon"

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

_RE_TIER = re.compile(r'capitalize"[^>]*>\s*([A-Za-z]+)\s*</span', re.S)
_RE_USAGE = re.compile(r'aria-label="([A-Za-z ]+usage) (\d+(?:\.\d+)?)% used"')
_RE_RESET_TIME = re.compile(r'data-time="([^"]+)"\s*>\s*Resets in')
_RE_SEGMENT = re.compile(
    r'data-usage-segment\b[^>]*?data-model="([^"]+)"[^>]*?data-requests="(\d+)"', re.S
)


def parse(html: str) -> dict:
    """Pure function of the settings page HTML -> {tier, windows, segments}.
    
    Scrapes:
    - Account tier (Free/Pro)
    - Total usage percentage and reset date
    - Per-model request counts from data-usage-segment attributes
    """
    if not re.search(r"Included usage|Cloud usage", html):
        raise AuthExpiredError("ollama.com session expired")

    m = _RE_TIER.search(html)
    tier = m.group(1).lower() if m else "unknown"

    usage = _RE_USAGE.search(html)
    reset = _RE_RESET_TIME.search(html)

    windows = [
        {
            "id": "usage",
            "label": usage.group(1).strip() if usage else "Usage",
            "letter": "Us",
            "pct": float(usage.group(2)) if usage else None,
            "resets_at": reset.group(1) if reset else None,
            "color": USAGE_COLOR,
            "will_deplete": False,
        },
    ]

    segments = [
        {"model": m.group(1), "requests": int(m.group(2))}
        for m in _RE_SEGMENT.finditer(html)
    ]

    return {"tier": tier, "windows": windows, "segments": segments}


def create_provider(client=None):
    state = {"cookie": None, "url": DEFAULT_URL, "client": client}

    def config():
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": DEFAULT_URL,
            "auth": {"kind": "cookie"},
            "windows": [
                {"id": "usage", "label": "Usage", "color": USAGE_COLOR},
            ],
            "tiers": ["free", "pro"],
        }

    def configure(cfg: dict | None = None):
        cfg = cfg or {}
        # !== undefined (not truthy) so configure({'cookie': ''}) can clear it.
        if "cookie" in cfg:
            state["cookie"] = cfg["cookie"]
        if cfg.get("url"):
            state["url"] = cfg["url"]
        if cfg.get("interval_seconds"):
            state["interval_seconds"] = int(cfg["interval_seconds"])

    async def fetch() -> str:
        if not state["cookie"]:
            raise AuthExpiredError("no ollama cookie configured")
        headers = {
            "Cookie": state["cookie"],
            "User-Agent": USER_AGENT,
            "Accept": "text/html",
        }
        c = state["client"] or create_client()
        res = await c.get(state["url"], headers=headers)
        if 300 <= res.status_code < 400:
            raise AuthExpiredError()
        if res.status_code == 429:
            ra = res.headers.get("retry-after")
            raise RateLimitedError(int(ra) if ra and ra.isdigit() else None)
        if res.status_code >= 400:
            raise RuntimeError(f"ollama.com HTTP {res.status_code}")
        return res.text

    return {
        "id": ID,
        "label": LABEL,
        "auth": {"kind": "cookie"},
        "config": config,
        "configure": configure,
        "fetch": fetch,
        "parse": parse,
        "interval_seconds": lambda: state.get("interval_seconds") or 300,
    }