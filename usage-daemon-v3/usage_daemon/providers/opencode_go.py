"""OpenCode Go usage provider plugin (port of src/providers/opencode-go.js).

Two sources, preferred in this order (per steipete/CodexBar's
docs/opencode.md, 2026-09 — an independent client documenting the same
opencode.ai backend; NOT verified live against a real OPENCODE_API_KEY here,
so field names are a best-effort reconstruction of that doc's notation):

  1. GET /zen/go/v1/usage, Bearer OPENCODE_API_KEY — the authoritative JSON
     API. Reports `usage.{rolling,weekly,monthly}.percent` (0..100) +
     `resetInSec` per window. No workspace-id discovery needed.
  2. Cookie-authed workspace "Go" page scrape (the pre-existing, confirmed-
     live path below) — used only when no api_key is configured.

Go subscription meters 3 rolling windows (5h / weekly / monthly), each
server-computed as {status, resetInSec, usagePercent}. Source is the
cookie-authed workspace "Go" page — a stable URL (no build-hash header, no
seroval RPC body, unlike the console's `_server` endpoint). Same shape as
ollama: cookie GET HTML -> scrape hydration -> windows.

The scraped usagePercent lags reality — opencode.ai only batch-updates it
periodically (confirmed live 2026-07-20: 117 local requests / $0.10 spend
over 5h while the scraped page still read "0%"). The local opencode CLI's
own SQLite db (~/.local/share/opencode/opencode.db) has per-message
{cost, providerID, time.created} rows updated in real time, so when that
file is readable we compute pct ourselves — sum(cost) over the trailing
window / the Go plan's published $ cap (5h=$12, weekly=$30, monthly=$60) —
and only fall back to the scraped percent when the db is missing/unreadable.

parse() is still a PURE function (takes an envelope — either raw HTML for
back-compat, or {html, localCosts, localSegments} JSON) so it unit-tests
against a vendored fixture with no network/fs. fetch() adds cookie/db
handling around it.
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import json
import os
import re
import sqlite3

from ..errors import AuthExpiredError, ProviderError, RateLimitedError
from ..httputil import create_client

ROLLING_COLOR = "#009E73"  # Okabe-Ito green (5h)
WEEKLY_COLOR = "#56B4E9"  # Okabe-Ito blue
MONTHLY_COLOR = "#E69F00"  # Okabe-Ito orange

ID = "opencode-go"
LABEL = "opencode.ai"

# Go plan's published $ limits (opencode.ai/docs usage-limits, confirmed live
# 2026-07-20). Rolling windows, not calendar-aligned.
CAPS = {"5h": 12, "weekly": 30, "monthly": 60}
WINDOW_MS = {
    "5h": 5 * 3600 * 1000,
    "weekly": 7 * 24 * 3600 * 1000,
    "monthly": 30 * 24 * 3600 * 1000,
}

BASE_URL = "https://opencode.ai"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) usage-daemon/0.1"
DEFAULT_DB_PATH = os.path.join(
    os.path.expanduser("~"), ".local", "share", "opencode", "opencode.db"
)


# Pull a `<key>:{...}` object literal out of the hydration script and read
# its fields by name (order in the source is not guaranteed). Real pages
# insert a Solid resumability reference between the key and the object
# literal — `rollingUsage:$R[33]={status:"ok",...}`, not `rollingUsage:{...}`
# — a hand-authored test fixture missed this and passed while the real page
# never matched (confirmed live 2026-07-18). The optional group tolerates
# that token generically (any `$R[<digits>]=`) without hardcoding an index.
def _extract_window(html: str, key: str):
    m = re.search(rf"{key}\s*:\s*(?:\$R\[\d+\]=)?\{{([^}}]*)\}}", html)
    if not m:
        return None
    body = m.group(1)
    sm = re.search(r'status\s*:\s*"([^"]+)"', body)
    rm = re.search(r"resetInSec\s*:\s*(\d+)", body)
    pm = re.search(r"usagePercent\s*:\s*(\d+(?:\.\d+)?)", body)
    return {
        "status": sm.group(1) if sm else None,
        "resetInSec": int(rm.group(1)) if rm else None,
        "usagePercent": float(pm.group(1)) if pm else None,
    }


# raw is either the legacy bare HTML string (test fixtures, old callers) or a
# JSON envelope { html, localCosts, localSegments } — localCosts/localSegments
# are null when the local db was unavailable at fetch time.
def _unwrap_envelope(raw):
    if isinstance(raw, str):
        try:
            maybe = json.loads(raw)
        except Exception:
            maybe = None
        if isinstance(maybe, dict) and isinstance(maybe.get("html"), str):
            return maybe.get("html"), maybe.get("localCosts"), maybe.get("localSegments")
        return raw, None, None
    if isinstance(raw, dict):
        return raw.get("html"), raw.get("localCosts"), raw.get("localSegments")
    return raw, None, None


# GET /zen/go/v1/usage response -> {tier, windows, segments}. Tolerant of the
# two field-name spellings docs/opencode.md's own text mixes ("usage.rolling
# .percent" vs "rollingUsage.usagePercent") since there's no live sample to
# pin one down against.
def _api_window(usage: dict, key: str, wid: str, label: str, letter: str, color: str):
    w = usage.get(key) if isinstance(usage, dict) else None
    if not isinstance(w, dict):
        return None
    pct = w.get("percent")
    if pct is None:
        pct = w.get("usagePercent")
    if not isinstance(pct, (int, float)) or isinstance(pct, bool):
        return None
    reset_sec = w.get("resetInSec")
    if reset_sec is None:
        reset_sec = w.get("reset_in_sec")
    resets_at = None
    if isinstance(reset_sec, (int, float)) and not isinstance(reset_sec, bool):
        dt = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=reset_sec)
        resets_at = dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return {
        "id": wid,
        "label": label,
        "letter": letter,
        "pct": float(pct),
        "resets_at": resets_at,
        "color": color,
        "will_deplete": False,
    }


def _parse_api(data: dict) -> dict:
    usage = data.get("usage")
    if not isinstance(usage, dict):
        raise AuthExpiredError("opencode.ai API response missing usage")

    rolling = _api_window(usage, "rolling", "5h", "5 Hour", "5h", ROLLING_COLOR)
    if not rolling:
        raise AuthExpiredError("opencode.ai API response missing rolling usage")
    weekly = _api_window(usage, "weekly", "weekly", "Weekly", "Wk", WEEKLY_COLOR)
    monthly = _api_window(usage, "monthly", "monthly", "Monthly", "Mo", MONTHLY_COLOR)

    tier = data.get("tier") or data.get("plan") or "lite"
    windows = [w for w in (rolling, weekly, monthly) if w]
    return {"tier": str(tier).lower(), "windows": windows, "segments": []}


# Narrow but whitespace-tolerant scrape of the Go page hydration payload.
def parse(raw) -> dict:
    # GET /zen/go/v1/usage JSON (api_key path) -> dispatch before the legacy
    # cookie-envelope unwrap below, which would otherwise misread this as HTML.
    if isinstance(raw, str):
        try:
            maybe = json.loads(raw)
        except Exception:
            maybe = None
        if isinstance(maybe, dict) and isinstance(maybe.get("usage"), dict):
            return _parse_api(maybe)
    elif isinstance(raw, dict) and isinstance(raw.get("usage"), dict):
        return _parse_api(raw)

    html, local_costs, local_segments = _unwrap_envelope(raw)
    if not isinstance(html, str) or "rollingUsage" not in html:
        raise AuthExpiredError()

    rolling = _extract_window(html, "rollingUsage")
    weekly = _extract_window(html, "weeklyUsage")
    monthly = _extract_window(html, "monthlyUsage")
    if not rolling:
        raise AuthExpiredError()

    tier_m = re.search(r'"plan"\s*:\s*"([^"]+)"', html) or re.search(
        r'tier\s*:\s*"([^"]+)"', html
    )
    tier = tier_m.group(1).lower() if tier_m else "lite"

    def resets_at(w):
        sec = w.get("resetInSec") if w else None
        if not isinstance(sec, (int, float)):
            return None
        dt = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=sec)
        return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    # "ok" is the normal in-budget status; opencode.ai also reports
    # "rate-limited" (confirmed live 2026-08-17) once a window is exhausted —
    # that response still carries a valid usagePercent (100), it's not an
    # error state. Only "error" means "no real data here."
    def scraped_pct(w):
        if w and w.get("status") in ("ok", "rate-limited"):
            return w.get("usagePercent")
        return None

    # Local db cost sum only informs the **5h rolling** window (the scraped
    # percentage lags there — batch-updated). Weekly/monthly are NOT
    # overridden: opencode.ai's own percentages are the authoritative billing
    # figure, and the local trailing-window sums diverge badly from it
    # (observed 2026-07-23: local weekly/monthly identical at $13.54 —
    # everything in the last 7 days — giving weekly 45% vs official 11%).
    #
    # Local can also *under*-report — confirmed live 2026-08-17: one $0
    # message in the trailing 5h (real usage on another device) computed 0%
    # while the scraped page correctly read ~100%. A local value is only
    # trustworthy when it's AHEAD of scraped, never behind: take the max.
    def pct_of(wid, w):
        cost = local_costs.get(wid) if isinstance(local_costs, dict) else None
        scraped = scraped_pct(w)
        if wid == "5h" and isinstance(cost, (int, float)) and not isinstance(cost, bool):
            local_pct = max(0, min(100, (100 * cost) / CAPS[wid]))
            return local_pct if scraped is None else max(local_pct, scraped)
        return scraped

    windows = [
        {
            "id": "5h",
            "label": "5 Hour",
            "letter": "5h",
            "pct": pct_of("5h", rolling),
            "resets_at": resets_at(rolling),
            "color": ROLLING_COLOR,
            "will_deplete": False,
        },
        {
            "id": "weekly",
            "label": "Weekly",
            "letter": "Wk",
            "pct": pct_of("weekly", weekly),
            "resets_at": resets_at(weekly),
            "color": WEEKLY_COLOR,
            "will_deplete": False,
        },
        {
            "id": "monthly",
            "label": "Monthly",
            "letter": "Mo",
            "pct": pct_of("monthly", monthly),
            "resets_at": resets_at(monthly),
            "color": MONTHLY_COLOR,
            "will_deplete": False,
        },
    ]

    segments = (
        [{"model": s.get("model"), "cost": s.get("cost")} for s in local_segments]
        if isinstance(local_segments, list)
        else []
    )

    return {"tier": tier, "windows": windows, "segments": segments}


# Reads the local opencode CLI's own SQLite db (WAL mode — safe to read
# concurrently with the CLI writing) for real-time per-window $ spend and a
# per-model breakdown. Soft-fails to None on any error (file missing/locked,
# daemon on a host without the CLI) so the scraped percent remains fallback.
def read_local_usage(db_path: str):
    db = None
    try:
        db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        now_ms = _dt.datetime.now(_dt.timezone.utc).timestamp() * 1000

        def sum_since(ms: float):
            row = db.execute(
                "SELECT SUM(json_extract(data,'$.cost')) FROM message"
                " WHERE json_extract(data,'$.providerID') = 'opencode-go'"
                " AND json_extract(data,'$.time.created') > ?",
                (now_ms - ms,),
            ).fetchone()
            return row[0] if row and isinstance(row[0], (int, float)) else 0

        costs = {
            "5h": sum_since(WINDOW_MS["5h"]),
            "weekly": sum_since(WINDOW_MS["weekly"]),
            "monthly": sum_since(WINDOW_MS["monthly"]),
        }
        seg_rows = db.execute(
            "SELECT json_extract(data,'$.modelID') AS model,"
            " SUM(json_extract(data,'$.cost')) AS cost"
            " FROM message"
            " WHERE json_extract(data,'$.providerID') = 'opencode-go'"
            " AND json_extract(data,'$.time.created') > ?"
            " GROUP BY model ORDER BY cost DESC",
            (now_ms - WINDOW_MS["monthly"],),
        ).fetchall()
        segments = [{"model": r[0], "cost": r[1]} for r in seg_rows if r[0]]
        return {"costs": costs, "segments": segments}
    except Exception:
        return None
    finally:
        if db is not None:
            db.close()


# config.py's expand-home convention resolves "~/" against the project dir on
# purpose (cookie files are relative to the daemon). The opencode CLI's real
# db lives under the actual OS home dir regardless of cwd, so db_path needs
# real tilde expansion instead.
def _expand_real_home(p):
    if not p:
        return p
    if p == "~":
        return os.path.expanduser("~")
    if p.startswith("~/"):
        return os.path.join(os.path.expanduser("~"), p[2:])
    return p


API_USAGE_URL = f"{BASE_URL}/zen/go/v1/usage"


# Error bodies observed live (2026-09-09, unauthenticated/bogus-key probes):
# {"type":"error","error":{"type":"AuthError","message":"Missing API key."}}
# {"type":"error","error":{"type":"AuthError","message":"Unauthorized"}}
# Surface that message instead of a bare status code so a rejected key says why.
def _api_error_detail(body: str) -> str | None:
    try:
        data = json.loads(body)
    except Exception:
        return None
    if isinstance(data, dict) and isinstance(data.get("error"), dict):
        msg = data["error"].get("message")
        if isinstance(msg, str) and msg:
            return msg
    return None


def create() -> dict:
    state = {"cookie": None, "workspace_id": None, "db_path": None, "api_key": None}

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://opencode.ai",
            "auth": {"kind": "token"},
            "windows": [
                {"id": "5h", "label": "5 Hour", "color": ROLLING_COLOR},
                {"id": "weekly", "label": "Weekly", "color": WEEKLY_COLOR},
                {"id": "monthly", "label": "Monthly", "color": MONTHLY_COLOR},
            ],
            "tiers": ["lite"],
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        # "in cfg" so configure({'cookie': ''}) can explicitly clear it.
        if "cookie" in cfg:
            state["cookie"] = cfg["cookie"]
        if "api_key" in cfg:
            state["api_key"] = (cfg["api_key"] or "").strip() or None
        # Accept either the bare id or a full workspace URL — matches
        # CodexBar's CODEXBAR_OPENCODE_WORKSPACE_ID convention, one less thing
        # to get wrong copy-pasting from the browser's address bar.
        wid = cfg.get("workspace_id")
        if wid:
            m = re.search(r"wrk_[A-Za-z0-9]+", str(wid))
            if m:
                state["workspace_id"] = m.group(0)
        if "db_path" in cfg:
            state["db_path"] = _expand_real_home(cfg.get("db_path"))

    async def set_auth(payload: str) -> None:
        state["api_key"] = (payload or "").strip() or None

    async def _discover_workspace_id() -> str:
        c = create_client()
        try:
            res = await c.get(
                f"{BASE_URL}/workspace",
                headers={"Cookie": state["cookie"], "User-Agent": USER_AGENT, "Accept": "text/html"},
            )
        finally:
            await c.aclose()
        if 300 <= res.status_code < 400:
            raise AuthExpiredError()
        if res.status_code == 429:
            ra = res.headers.get("retry-after")
            raise RateLimitedError(int(ra) if ra and ra.isdigit() else None)
        if res.status_code >= 400:
            raise ProviderError(f"opencode.ai HTTP {res.status_code}")
        m = re.search(r"\bwrk_[A-Za-z0-9]+\b", res.text)
        if not m:
            raise AuthExpiredError("could not discover opencode workspace id")
        return m.group(0)

    async def _fetch_api() -> str:
        c = create_client()
        try:
            res = await c.get(
                API_USAGE_URL,
                headers={
                    "Authorization": f"Bearer {state['api_key']}",
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                },
            )
        finally:
            await c.aclose()
        if res.status_code in (401, 403):
            detail = _api_error_detail(res.text)
            raise AuthExpiredError(f"opencode.ai API key rejected: {detail}" if detail else "opencode.ai API key rejected")
        if res.status_code == 429:
            ra = res.headers.get("retry-after")
            raise RateLimitedError(int(ra) if ra and ra.isdigit() else None)
        if res.status_code >= 400:
            detail = _api_error_detail(res.text)
            raise ProviderError(f"opencode.ai HTTP {res.status_code}" + (f": {detail}" if detail else ""))
        return res.text

    async def fetch() -> str:
        if state["api_key"]:
            return await _fetch_api()
        if not state["cookie"]:
            raise AuthExpiredError("no opencode-go api key or cookie configured")
        if not state["workspace_id"]:
            state["workspace_id"] = await _discover_workspace_id()

        c = create_client()
        try:
            res = await c.get(
                f"{BASE_URL}/workspace/{state['workspace_id']}/go",
                headers={"Cookie": state["cookie"], "User-Agent": USER_AGENT, "Accept": "text/html"},
            )
        finally:
            await c.aclose()
        if 300 <= res.status_code < 400:
            raise AuthExpiredError()
        if res.status_code == 429:
            ra = res.headers.get("retry-after")
            raise RateLimitedError(int(ra) if ra and ra.isdigit() else None)
        if res.status_code >= 400:
            raise ProviderError(f"opencode.ai HTTP {res.status_code}")
        html = res.text

        local = await asyncio.to_thread(read_local_usage, state["db_path"] or DEFAULT_DB_PATH)
        return json.dumps(
            {
                "html": html,
                "localCosts": local["costs"] if local else None,
                "localSegments": local["segments"] if local else None,
            }
        )

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


