"""ElevenLabs usage provider plugin (port of src/providers/elevenlabs.js)."""

from __future__ import annotations

import datetime as _dt
import json
import math

from ..errors import AuthExpiredError, RateLimitedError
from ..httputil import create_client

CHARACTERS_COLOR = "#0072B2"
VOICE_SLOTS_COLOR = "#CC79A7"

ID = "elevenlabs"
LABEL = "ElevenLabs"

DEFAULT_API_URL = "https://api.elevenlabs.io"
SUBSCRIPTION_PATH = "/v1/user/subscription"
USER_AGENT = "usage-daemon/0.1"


def _clamp_pct(n):
    if not isinstance(n, (int, float)) or isinstance(n, bool) or not math.isfinite(n):
        return None
    return max(0.0, min(100.0, float(n)))


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _unix_to_iso(ts) -> str | None:
    if not _num(ts):
        return None
    return _dt.datetime.fromtimestamp(float(ts), _dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def parse(raw) -> dict:
    try:
        env = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable ElevenLabs subscription response")
    if not isinstance(env, dict) or not _num(env.get("character_count")):
        raise AuthExpiredError("no usable ElevenLabs subscription figures")

    consumed = env["character_count"]
    cap = env.get("character_limit") if _num(env.get("character_limit")) else None
    resets_at = _unix_to_iso(env.get("next_character_count_reset_unix"))

    windows = [{
        "id": "characters",
        "label": "Characters",
        "letter": "Ch",
        "pct": _clamp_pct((100 * consumed) / cap) if cap is not None and cap > 0 else None,
        "used": max(0, cap - consumed) if cap is not None else None,
        "used_is_remaining": True,
        "cap": cap,
        "unit": "characters",
        "resets_at": resets_at,
        "color": CHARACTERS_COLOR,
        "will_deplete": False,
    }]

    if _num(env.get("voice_slots_used")) and _num(env.get("voice_limit")):
        voice_limit = env["voice_limit"]
        voice_used = env["voice_slots_used"]
        windows.append({
            "id": "voice_slots",
            "label": "Voice Slots",
            "letter": "Vs",
            "pct": _clamp_pct((100 * voice_used) / voice_limit) if voice_limit > 0 else None,
            "used": voice_used,
            "cap": voice_limit,
            "unit": "voices",
            "resets_at": None,
            "color": VOICE_SLOTS_COLOR,
            "will_deplete": False,
        })

    return {
        "tier": env.get("tier") or None,
        "windows": windows,
        "segments": [],
        "_elevenlabs": {
            "character_count": consumed,
            "character_limit": cap,
            "account_status": env.get("status") or None,
            "tier": env.get("tier") or None,
        },
    }


def create() -> dict:
    state = {"api_key": None, "api_url": DEFAULT_API_URL, "last_stats": None}

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://elevenlabs.io/app/settings/api-keys",
            "auth": {"kind": "token"},
            "category": "support",
            "windows": [{"id": "characters", "label": "Characters", "color": CHARACTERS_COLOR}],
            "tiers": [],
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        if "api_key" in cfg:
            state["api_key"] = str(cfg["api_key"]).strip() if cfg["api_key"] else None
        if cfg.get("api_url"):
            state["api_url"] = str(cfg["api_url"]).strip().rstrip("/")

    async def set_auth(payload: str) -> None:
        state["api_key"] = str(payload or "").strip() or None

    async def fetch() -> str:
        if not state["api_key"]:
            raise AuthExpiredError("no ElevenLabs API key configured")
        c = create_client()
        try:
            res = await c.get(
                f"{state['api_url']}{SUBSCRIPTION_PATH}",
                headers={
                    "xi-api-key": state["api_key"],
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
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
            raise RuntimeError(f"api.elevenlabs.io HTTP {res.status_code}")
        state["last_stats"] = parse(res.text)["_elevenlabs"]
        return res.text

    def meta() -> dict:
        s = state["last_stats"]
        if not s:
            return {}
        return {
            "character_count": s["character_count"],
            "character_limit": s["character_limit"],
            "account_status": s["account_status"],
        }

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
