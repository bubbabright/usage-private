"""Groq usage provider plugin (port of src/providers/groq.js)."""

from __future__ import annotations

import datetime as _dt
import json
import math
import re
from typing import Any

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

RPD_COLOR = "#CC79A7"

ID = "groq"
LABEL = "Groq"

CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
USER_AGENT = "usage-daemon/0.1"
DEFAULT_MODEL = "openai/gpt-oss-20b"


def _clamp_pct(n):
    if not isinstance(n, (int, float)) or isinstance(n, bool) or not math.isfinite(n):
        return None
    return max(0.0, min(100.0, float(n)))


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _as_num(v) -> float | None:
    return float(v) if _num(v) else None


def parse_duration(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if not isinstance(value, str) or not value:
        return None
    m = re.match(r"^(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)(ms|s)$", value)
    if not m:
        return None
    hours = float(m.group(1) or 0)
    minutes = float(m.group(2) or 0)
    amount = float(m.group(3))
    seconds = amount / 1000 if m.group(4) == "ms" else amount
    return hours * 3600 + minutes * 60 + seconds


def _iso_after(seconds: float) -> str:
    dt = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=seconds)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse(raw) -> dict:
    try:
        env = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable groq envelope")
    if not isinstance(env, dict):
        raise AuthExpiredError("unparseable groq envelope")

    windows = []
    limit_req = env.get("limit_requests")
    rem_req = env.get("remaining_requests")
    limit_req_value = _as_num(limit_req)
    rem_req_value = _as_num(rem_req)
    if limit_req_value is not None and limit_req_value > 0 and rem_req_value is not None:
        windows.append({
            "id": "daily_requests",
            "label": "Requests/day",
            "letter": "Rq",
            "pct": _clamp_pct(100 * (1 - (rem_req_value / limit_req_value))),
            "resets_at": env.get("reset_requests_at") or None,
            "color": RPD_COLOR,
            "will_deplete": False,
        })
    if not windows:
        raise AuthExpiredError("no usable Groq rate-limit headers in envelope")
    return {"tier": None, "windows": windows, "segments": []}


def create() -> dict:
    state: dict[str, Any] = {"api_key": None, "model": DEFAULT_MODEL}

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://console.groq.com/usage",
            "auth": {"kind": "token"},
            "windows": [{"id": "daily_requests", "label": "Requests/day", "color": RPD_COLOR}],
            "tiers": [],
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        if "api_key" in cfg:
            state["api_key"] = str(cfg["api_key"]).strip() if cfg["api_key"] else None
        if cfg.get("model"):
            state["model"] = str(cfg["model"]).strip()

    async def set_auth(payload: str) -> None:
        state["api_key"] = str(payload or "").strip() or None

    async def fetch() -> str:
        if not state["api_key"]:
            raise AuthExpiredError("no Groq API key configured")
        c = create_client()
        try:
            res = await c.post(
                CHAT_URL,
                headers={
                    "Authorization": f"Bearer {state['api_key']}",
                    "Content-Type": "application/json",
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                },
                content=json.dumps({
                    "model": state["model"],
                    "messages": [{"role": "user", "content": "hi"}],
                    "max_tokens": 1,
                }),
            )
            _ = res.text
        finally:
            await c.aclose()
        if res.status_code in (401, 403):
            raise AuthExpiredError()
        if res.status_code == 429:
            ra = res.headers.get("retry-after")
            raise RateLimitedError(int(ra) if ra and ra.isdigit() else None)
        if res.status_code >= 400:
            raise RuntimeError(f"api.groq.com HTTP {res.status_code}")

        limit_requests = res.headers.get("x-ratelimit-limit-requests")
        remaining_requests = res.headers.get("x-ratelimit-remaining-requests")
        reset_requests = parse_duration(res.headers.get("x-ratelimit-reset-requests"))
        try:
            limit_requests = float(limit_requests) if limit_requests is not None else None
        except ValueError:
            limit_requests = None
        try:
            remaining_requests = float(remaining_requests) if remaining_requests is not None else None
        except ValueError:
            remaining_requests = None
        envelope = {
            "limit_requests": limit_requests if _num(limit_requests) else None,
            "remaining_requests": remaining_requests if _num(remaining_requests) else None,
            "reset_requests_at": _iso_after(reset_requests) if reset_requests is not None else None,
        }
        return json.dumps(envelope)

    return {
        "id": ID,
        "label": LABEL,
        "auth": {"kind": "token"},
        "config": config,
        "configure": configure,
        "set_auth": set_auth,
        "fetch": fetch,
        "interval_seconds": lambda: 900,
        "meta": dict,
        "parse": parse,
    }
