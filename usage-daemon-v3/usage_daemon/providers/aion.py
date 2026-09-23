"""Aion Labs account usage provider.

Aion renders quota and recent request usage server-side. Authentication uses
the browser session cookie, which can be refreshed from Firefox on demand.
"""

from __future__ import annotations

import html
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from ..errors import AuthExpiredError, ProviderError, RateLimitedError
from ..httputil import create_client

TOKEN_COLOR = "#F0E442"

ID = "aion"
LABEL = "Aion Labs"
USAGE_URL = "https://www.aionlabs.ai/app/usage/"
USER_AGENT = "usage-daemon/0.1"


def next_utc_midnight() -> str:
    now = datetime.now(timezone.utc)
    reset = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if reset <= now:
        reset += timedelta(days=1)
    return reset.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _number(value: str) -> int | float | None:
    value = value.replace(",", "").strip()
    try:
        number = float(value)
    except ValueError:
        return None
    return int(number) if number.is_integer() else number


def parse(raw: str) -> dict:
    """Parse the server-rendered usage page into the standard snapshot shape."""
    if not isinstance(raw, str) or re.search(
        r"<title>\s*Sign In\b|action=[\"']/accounts/login/", raw, re.I
    ):
        raise AuthExpiredError("aionlabs.ai session expired")

    text = re.sub(r"<[^>]+>", " ", html.unescape(raw))
    text = re.sub(r"\s+", " ", text)

    def detail(label: str):
        match = re.search(
            rf"{label}\s+([0-9][0-9,]*(?:\.[0-9]+)?)", text, re.I
        )
        return _number(match.group(1)) if match else None

    used = detail("Daily tokens used")
    cap = detail("Free-tier daily limit")
    remaining = detail("Tokens remaining today")
    if used is None or cap is None or cap <= 0:
        # Auth is fine (login-page check above passed) — this is a parse failure,
        # not an expiry. AuthExpiredError would trigger a pointless Firefox
        # cookie refresh and a 30-min retry floor; ProviderError backoffs normally.
        raise ProviderError("no usable Aion Labs quota figures")

    segments = []
    row_re = re.compile(r"<tr[^>]*>(.*?)</tr>", re.I | re.S)
    cell_re = re.compile(r"<td[^>]*>(.*?)</td>", re.I | re.S)
    for row in row_re.finditer(raw):
        cells = [
            re.sub(r"<[^>]+>", "", html.unescape(cell)).strip()
            for cell in cell_re.findall(row.group(1))
        ]
        # Exactly 8: a wider row (e.g. a new column) must be skipped whole —
        # matching a fixed 8 anywhere inside it would silently mis-slot cells.
        if len(cells) != 8:
            continue
        input_tokens = _number(cells[3])
        cached_tokens = _number(cells[4])
        output_tokens = _number(cells[5])
        total_tokens = _number(cells[6])
        cost = cells[7].replace("$", "").replace(",", "").strip()
        cost_value = _number(cost)
        if cells[2] and total_tokens is not None:
            segments.append(
                {
                    "model": cells[2],
                    "input_tokens": input_tokens,
                    "cache_tokens": cached_tokens,
                    "output_tokens": output_tokens,
                    "total_tokens": total_tokens,
                    "cost_usd": cost_value,
                }
            )

    return {
        "tier": "free",
        "windows": [
            {
                "id": "daily_tokens",
                "label": "Tokens",
                "letter": "Tk",
                "pct": max(0, min(100, 100 * used / cap)),
                "used": used,
                "cap": cap,
                "unit": "tokens",
                "resets_at": next_utc_midnight(),
                "color": TOKEN_COLOR,
                "will_deplete": False,
            }
        ],
        "segments": segments,
        "_aion": {"used": used, "cap": cap, "remaining": remaining},
    }


def create() -> dict:
    state: dict[str, Any] = {"cookie": None}

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": USAGE_URL,
            "auth": {
                "kind": "cookie",
                "cookie_from_firefox": "aionlabs.ai",
            },
            "category": "support",
            "windows": [{"id": "daily_tokens", "label": "Tokens", "color": TOKEN_COLOR}],
            "tiers": ["free"],
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        if "cookie" in cfg:
            state["cookie"] = str(cfg["cookie"]).strip() if cfg["cookie"] else None

    async def fetch() -> str:
        if not state["cookie"]:
            raise AuthExpiredError("no Aion Labs session cookie configured")
        c = create_client()
        try:
            res = await c.get(
                USAGE_URL,
                headers={
                    "Cookie": state["cookie"],
                    "User-Agent": USER_AGENT,
                    "Accept": "text/html",
                },
            )
        finally:
            await c.aclose()
        if 300 <= res.status_code < 400:
            raise AuthExpiredError()
        if res.status_code == 429:
            retry_after = res.headers.get("retry-after")
            raise RateLimitedError(
                int(retry_after) if retry_after and retry_after.isdigit() else None
            )
        if res.status_code >= 400:
            raise RuntimeError(f"www.aionlabs.ai HTTP {res.status_code}")
        return res.text

    return {
        "id": ID,
        "label": LABEL,
        "auth": {"kind": "cookie"},
        "config": config,
        "configure": configure,
        "fetch": fetch,
        "interval_seconds": lambda: 300,
        "parse": parse,
    }
