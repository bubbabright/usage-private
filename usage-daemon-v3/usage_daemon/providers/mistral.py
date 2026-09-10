"""Mistral usage provider plugin (port of src/providers/mistral.js).

vibe_monthly (required path): free-tier Vibe Code usage via cookie tRPC GET
admin.mistral.ai/api/local-trpc/billing.budget -> result.data.json.vibe_budget
= {usage_percentage (ready-made 0-100), initial_budget, currency, reset_at,
payg_enabled}. api_budget (same shape) is a bonus window from the same call.
monthly_spend (optional): Admin-role API key, GET console.mistral.ai/api/admin
/usage + /admin/spend-limit.

parse() is a PURE function of a combined envelope string
  {"vibe": <json text|null>, "usage": ..., "spend_limit": ...}
so it unit-tests against fixtures with no network/fs. fetch() assembles the
envelope. Never writes Admin keys or Mistral credential files.
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import json
import math
from urllib.parse import quote

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

VIBE_COLOR = "#E69F00"  # Okabe-Ito orange
API_COLOR = "#009E73"  # Okabe-Ito green
SPEND_COLOR = "#56B4E9"  # Okabe-Ito blue

ID = "mistral"
LABEL = "Mistral"

_VIBE_INPUT = json.dumps(
    {"json": None, "meta": {"values": ["undefined"], "v": 1}}, separators=(",", ":")
)
VIBE_URL = (
    "https://admin.mistral.ai/api/local-trpc/billing.budget?input="
    + quote(_VIBE_INPUT, safe="")
)
ADMIN_BASE = "https://console.mistral.ai/api/admin"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) usage-daemon/0.1"

# Category keys documented / observed on the usage dashboard.
SPEND_CATEGORY_KEYS = [
    "chat",
    "completion",
    "ocr",
    "audio",
    "connectors",
    "libraries_api",
    "libraries",
    "fine_tuning",
    "vibe_usage",
    "vibe",
]


def next_month_start_utc(from_dt: _dt.datetime | None = None) -> str:
    """First of next calendar month, UTC (Vibe + spend both reset this way)."""
    d = from_dt or _dt.datetime.now(_dt.timezone.utc)
    y, m = d.year, d.month
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    return f"{ny:04d}-{nm:02d}-01T00:00:00Z"


def _parse_iso_ms(s):
    """Date.parse() equivalent: epoch ms, or None when unparseable."""
    if not isinstance(s, str):
        return None
    try:
        return _dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000
    except Exception:
        return None


def vibe_interval_seconds(
    pct,
    reset_at_iso,
    now: _dt.datetime | None = None,
    *,
    base: int = 300,
    cap_seconds: int = 24 * 3600,
) -> int:
    """Vibe-only backoff: once the monthly meter reads 100%, re-polling every
    base interval just re-confirms "still maxed" until the real reset — back
    off to at most cap_seconds per hop (re-armed repeatedly by
    interval_seconds() until the real reset). Worst case the display shows a
    stale 100% for up to cap_seconds after the real reset."""
    if pct != 100 or not reset_at_iso:
        return base
    reset_ms = _parse_iso_ms(reset_at_iso)
    if reset_ms is None:
        return base
    now_ms = (now or _dt.datetime.now(_dt.timezone.utc)).timestamp() * 1000
    seconds_until_reset = math.floor((reset_ms - now_ms) / 1000)
    if seconds_until_reset <= 0:  # clock skew / just-past-reset: repoll promptly
        return base
    return min(int(seconds_until_reset), cap_seconds)

def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


# Pull the billing.budget payload out of the tRPC envelope:
# result.data.json, tolerating an already-unwrapped shape (JS ?? chain).
def _budget_payload(obj):
    if not isinstance(obj, dict):
        return None
    v = None
    r = obj.get("result")
    if isinstance(r, dict) and isinstance(r.get("data"), dict):
        v = r["data"].get("json")
    if v is None and isinstance(obj.get("data"), dict):
        v = obj["data"].get("json")
    return obj if v is None else v


# A single { usage_percentage, reset_at, payg_enabled } budget leg -> window
# fields. Clamps pct 0-100; falls back to next_month_start_utc() if reset_at is
# missing/malformed (matches the old dollar-meter's derived reset).
def _budget_window(budget):
    if not isinstance(budget, dict) or not _num(budget.get("usage_percentage")):
        return None
    pct = max(0, min(100, budget["usage_percentage"]))
    reset_at = budget.get("reset_at")
    if not isinstance(reset_at, str) or _parse_iso_ms(reset_at) is None:
        reset_at = next_month_start_utc()
    return {"pct": pct, "resetAt": reset_at, "paygEnabled": bool(budget.get("payg_enabled"))}


# Sum $ spend from Admin /usage body. Tolerant of total field or category map.
def extract_spend_total(usage):
    if not isinstance(usage, dict):
        return None

    for k in ("total", "total_cost", "total_amount", "amount", "usage"):
        v = usage.get(k)
        if _num(v):
            return v
        if isinstance(v, dict):
            if _num(v.get("amount")):
                return v["amount"]
            if _num(v.get("total")):
                return v["total"]

    total = 0.0
    found = False
    for k in SPEND_CATEGORY_KEYS:
        v = usage.get(k)
        if _num(v):
            total += v
            found = True
        elif isinstance(v, dict):
            for ck in ("amount", "cost", "total", "usd"):
                if _num(v.get(ck)):
                    total += v[ck]
                    found = True
                    break
    if found:
        return total

    # Nested { costs: { completion: 1.2, ... } } style
    costs = usage.get("costs") or usage.get("breakdown") or usage.get("categories")
    if isinstance(costs, dict):
        s = 0.0
        n = 0
        for v in costs.values():
            if _num(v):
                s += v
                n += 1
            elif isinstance(v, dict):
                for ck in ("amount", "cost", "total"):
                    if _num(v.get(ck)):
                        s += v[ck]
                        n += 1
                        break
        if n:
            return s

    return None


def _period_end_from_usage(usage):
    if not isinstance(usage, dict):
        return None
    for k in ("end", "period_end", "billing_period_end", "periodEnd", "end_date"):
        v = usage.get(k)
        if isinstance(v, str) and v:
            return v
    # month/year -> first of the month AFTER the usage month (API months are
    # 1-based; the JS passes the value straight into the 0-based Date.UTC
    # month param, so month 7 -> August 1).
    month = usage.get("month", usage.get("Month"))
    year = usage.get("year", usage.get("Year"))
    if _num(month) and _num(year):
        y, m = int(year), int(month)
        ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
        return f"{ny:04d}-{nm:02d}-01T00:00:00Z"
    return None


def _load_envelope(raw):
    try:
        env = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable mistral envelope")
    if not isinstance(env, dict):
        raise AuthExpiredError("unparseable mistral envelope")
    return env


# Pure function of the envelope JSON text — no fs/network.
def parse(raw) -> dict:
    env = _load_envelope(raw)

    windows: list[dict] = []
    tier = None
    vibe_ok = False
    spend_ok = False
    vibe_cache = None  # { pct, resetAt } for fetch()'s intervalSeconds cache

    # --- vibe_monthly (+ bonus api_monthly, same call/cookie) ---
    if env.get("vibe"):
        try:
            vibe_raw = json.loads(env["vibe"]) if isinstance(env["vibe"], str) else env["vibe"]
        except Exception:
            vibe_raw = None
        body = _budget_payload(vibe_raw) or {}

        vibe = _budget_window(body.get("vibe_budget"))
        if vibe:
            windows.append({
                "id": "vibe_monthly",
                "label": "Vibe",
                "letter": "Vb",
                "pct": vibe["pct"],
                "resets_at": vibe["resetAt"],
                "color": VIBE_COLOR,
                "will_deplete": False,
            })
            vibe_ok = True
            vibe_cache = {"pct": vibe["pct"], "resetAt": vibe["resetAt"]}
            # Free-tier: a $10 cap with payg_enabled=false is the free plan;
            # PAYG accounts flip payg_enabled true.
            if not vibe["paygEnabled"]:
                tier = "free"

        api = _budget_window(body.get("api_budget"))
        if api:
            windows.append({
                "id": "api_monthly",
                "label": "API",
                "letter": "Ap",
                "pct": api["pct"],
                "resets_at": api["resetAt"],
                "color": API_COLOR,
                "will_deplete": False,
            })

    # --- monthly_spend (optional; needs both legs) ---
    if env.get("usage") and env.get("spend_limit"):
        usage_obj = limit_obj = None
        try:
            usage_obj = json.loads(env["usage"]) if isinstance(env["usage"], str) else env["usage"]
            limit_obj = (
                json.loads(env["spend_limit"])
                if isinstance(env["spend_limit"], str)
                else env["spend_limit"]
            )
        except Exception:
            usage_obj = limit_obj = None

        if usage_obj and isinstance(limit_obj, dict):
            spend = extract_spend_total(usage_obj)
            no_limit = bool(limit_obj.get("no_monthly_limit"))
            cap = None
            for ck in ("amount", "limit"):
                if _num(limit_obj.get(ck)):
                    cap = limit_obj[ck]
                    break

            pct = None
            if not no_limit and cap is not None and cap > 0 and spend is not None:
                pct = (100 * spend) / cap
            # cap known but spend unreadable, or no_monthly_limit -> the window
            # is still emitted with pct null (real plan state, not auth failure)

            windows.append({
                "id": "monthly_spend",
                "label": "Spend",
                "letter": "$",
                "pct": pct,
                "resets_at": _period_end_from_usage(usage_obj) or next_month_start_utc(),
                "color": SPEND_COLOR,
                "will_deplete": False,
            })
            spend_ok = True

    if not vibe_ok and not spend_ok:
        raise AuthExpiredError(
            "no usable Mistral meter (cookie vibe and/or Admin spend failed)"
        )

    return {"tier": tier, "windows": windows, "segments": [], "_vibe": vibe_cache}


def create() -> dict:
    state = {
        "cookie": None,
        "admin_key": None,
        "last_vibe_pct": None,
        "last_vibe_reset_at": None,
    }

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://console.mistral.ai/usage",
            "auth": {"kind": "cookie"},
            "windows": [
                {"id": "vibe_monthly", "label": "Vibe", "color": VIBE_COLOR},
                {"id": "api_monthly", "label": "API", "color": API_COLOR},
                {"id": "monthly_spend", "label": "Spend", "color": SPEND_COLOR},
            ],
            "tiers": ["free"],
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        # "in cfg" (not truthy) so configure({"cookie": ""}) can explicitly
        # clear it — a flush action, not just "no change was requested".
        if "cookie" in cfg:
            state["cookie"] = cfg["cookie"]
        if cfg.get("admin_key"):
            state["admin_key"] = str(cfg["admin_key"]).strip()
        if cfg.get("adminKey"):
            state["admin_key"] = str(cfg["adminKey"]).strip()

    async def _get(url: str, headers: dict):
        c = create_client()  # follow_redirects=False == JS redirect:'manual'
        try:
            return await c.get(url, headers=headers)
        finally:
            await c.aclose()

    async def fetch() -> str:
        vibe = usage = spend_limit = None
        vibe_auth_failed = False
        vibe_rate_limited = None
        vibe_status = None  # real HTTP status / network-error text, for diagnosis
        spend_auth_failed = False
        spend_rate_limited = None
        had_admin_attempt = False
        cookie = state["cookie"]

        # --- Vibe (cookie) ---
        if cookie:
            try:
                res = await _get(
                    VIBE_URL,
                    {
                        "Cookie": cookie,
                        "User-Agent": USER_AGENT,
                        "Accept": "application/json",
                    },
                )
                vibe_status = f"HTTP {res.status_code}"
                if 300 <= res.status_code < 400:
                    # A 3xx here is Mistral bouncing an expired cookie to login —
                    # treat as auth, but keep the status (and where it pointed)
                    # so it's explicit, not a blanket "any redirect = auth".
                    location = res.headers.get("location")
                    vibe_status = f"HTTP {res.status_code}" + (f" -> {location}" if location else "")
                    vibe_auth_failed = True
                elif res.status_code in (401, 403):
                    vibe_auth_failed = True
                elif res.status_code == 429:
                    ra = res.headers.get("retry-after")
                    vibe_rate_limited = int(ra) if ra and ra.isdigit() else None
                elif res.status_code < 400:
                    vibe = res.text
                # other HTTP errors: leave vibe None (soft) — vibe_status carries why
            except Exception as err:
                # network — soft fail; may still have spend. Keep the message.
                vibe_status = f"network error: {err}"
        else:
            vibe_auth_failed = True

        # --- Admin spend (optional key) ---
        if state["admin_key"]:
            had_admin_attempt = True
            headers = {
                "x-api-key": state["admin_key"],
                "Accept": "application/json",
                "User-Agent": USER_AGENT,
            }
            now = _dt.datetime.now(_dt.timezone.utc)
            usage_url = f"{ADMIN_BASE}/usage?month={now.month}&year={now.year}"
            limit_url = f"{ADMIN_BASE}/spend-limit"
            try:
                usage_res, limit_res = await asyncio.gather(
                    _get(usage_url, headers), _get(limit_url, headers)
                )
                st = (usage_res.status_code, limit_res.status_code)
                if st[0] in (401, 403) or st[1] in (401, 403):
                    spend_auth_failed = True
                elif st[0] == 429 or st[1] == 429:
                    ra = usage_res.headers.get("retry-after") or limit_res.headers.get("retry-after")
                    spend_rate_limited = int(ra) if ra and ra.isdigit() else None
                else:
                    if st[0] < 400:
                        usage = usage_res.text
                    if st[1] < 400:
                        spend_limit = limit_res.text
            except Exception:
                pass  # soft — vibe may still work

        # Prefer rate-limit signal if that's all we got
        if not vibe and not usage and not spend_limit:
            if vibe_rate_limited is not None or spend_rate_limited is not None:
                raise RateLimitedError(
                    vibe_rate_limited if vibe_rate_limited is not None else spend_rate_limited
                )
            # Both paths failed auth (or no admin key and cookie dead)
            if vibe_auth_failed and (not had_admin_attempt or spend_auth_failed):
                raise AuthExpiredError(
                    (
                        f"Mistral cookie rejected (vibe {vibe_status or 'no response'})"
                        " and Admin spend unavailable"
                    )
                    if cookie
                    else "no Mistral cookie configured"
                )
            # Not classified as auth/rate-limit but still no data — surface the
            # real status so a retired endpoint / 5xx / network error is
            # diagnosable instead of the old dead-end "produced no meter data".
            raise AuthExpiredError(
                f"Mistral vibe fetch produced no meter data ({vibe_status or 'no request made'})"
            )

        envelope = json.dumps({"vibe": vibe, "usage": usage, "spend_limit": spend_limit})
        try:
            parsed = parse(envelope)
            if parsed.get("_vibe"):
                state["last_vibe_pct"] = parsed["_vibe"]["pct"]
                state["last_vibe_reset_at"] = parsed["_vibe"]["resetAt"]
        except Exception:
            # soft — the runner's own parse(raw) call raises the real error for
            # this poll; don't let cache-priming crash fetch()
            pass
        return envelope

    def interval_seconds() -> int:
        if state["admin_key"]:
            return 300  # monthly_spend needs its own cadence
        return vibe_interval_seconds(state["last_vibe_pct"], state["last_vibe_reset_at"])

    return {
        "id": ID,
        "label": LABEL,
        "auth": {"kind": "cookie"},
        "config": config,
        "configure": configure,
        "fetch": fetch,
        "interval_seconds": interval_seconds,
        "meta": lambda: {},
        "parse": parse,
    }

