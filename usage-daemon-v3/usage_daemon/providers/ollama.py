"""Ollama Cloud usage provider plugin (port of src/providers/ollama.js).

No JSON usage API — account usage is server-rendered HTML at
https://ollama.com/settings ("Usage" tab, htmx). Auth is the browser session
cookie, NOT the API key.

parse() is a PURE function of the page HTML so it unit-tests against the
vendored fixture (tests/fixtures/ollama-settings.html) with no network.
fetch() adds the fetch + auth-expiry detection around it.
"""

from __future__ import annotations

import re

SESSION_COLOR = "#E69F00"  # Okabe-Ito orange
WEEKLY_COLOR = "#56B4E9"  # Okabe-Ito blue

ID = "ollama"
LABEL = "Ollama Cloud"

DEFAULT_URL = "https://ollama.com/settings"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) usage-daemon"

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

_RE_TIER = re.compile(r'capitalize"[^>]*>\s*([A-Za-z]+)\s*</span', re.S)
_RE_SESSION = re.compile(r'aria-label="Session usage (\d+(?:\.\d+)?)% used"')
_RE_WEEKLY = re.compile(r'aria-label="Weekly usage (\d+(?:\.\d+)?)% used"')
_RE_TIME = re.compile(r'data-time="([^"]+)"')
_RE_SEGMENT = re.compile(
    r'data-usage-segment\b[^>]*?data-model="([^"]+)"[^>]*?data-requests="(\d+)"', re.S
)


def parse(html: str) -> dict:
    """Pure function of the settings page HTML -> {tier, windows, segments}."""
    if not re.search(r"Cloud usage", html):
        raise AuthExpiredError("ollama.com session expired")

    m = _RE_TIER.search(html)
    tier = m.group(1).lower() if m else "unknown"

    sess = _RE_SESSION.search(html)
    week = _RE_WEEKLY.search(html)

    times = [m2.group(1) for m2 in _RE_TIME.finditer(html)]

    windows = [
        {
            "id": "session",
            "label": "Session",
            "letter": "Se",
            "pct": float(sess.group(1)) if sess else None,
            "resets_at": times[0] if len(times) > 0 else None,
            "color": SESSION_COLOR,
            "will_deplete": False,
        },
        {
            "id": "weekly",
            "label": "Weekly",
            "letter": "Wk",
            "pct": float(week.group(1)) if week else None,
            "resets_at": times[1] if len(times) > 1 else None,
            "color": WEEKLY_COLOR,
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
                {"id": "session", "label": "Session", "color": SESSION_COLOR},
                {"id": "weekly", "label": "Weekly", "color": WEEKLY_COLOR},
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