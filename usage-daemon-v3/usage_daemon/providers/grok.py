"""Grok / SuperGrok usage provider plugin (port of src/providers/grok.js).

Two transports, one poll (mirrors grok-usage-extension/extension.js):
  - MONTHLY: clean JSON off the CLI proxy
    GET https://cli-chat-proxy.grok.com/v1/billing  (Bearer)
  - WEEKLY : undocumented gRPC-web protobuf off grok.com
    POST .../GetGrokCreditsConfig  (empty gRPC-web frame -> protobuf scan)
Weekly is BEST-EFFORT / non-fatal — only monthly drives error state, exactly
like the extension. The token is read from ~/.grok/auth.json (the same file
the `grok` CLI manages). READ-ONLY: this daemon never refreshes the token —
expired/missing -> auth_expired, clients render last-known-good dimmed.
`grok login` remains the only thing that mutates that file.

parse() is a PURE function of a combined envelope string
  {"billing": "<monthly json text>", "credits": "<base64 weekly bytes|null>"}
Field mapping / protobuf scan ported verbatim from the live extension (the
extractor is the spec — read it, don't guess the shapes).
"""

from __future__ import annotations

import base64
import datetime as _dt
import json
import math
import struct
import time
from pathlib import Path

from ..errors import AuthExpiredError, ProviderError, RateLimitedError
from ..httputil import create_client

# Grok inverts claude's color mapping (see grok-usage-extension/stylesheet.css).
MONTHLY_COLOR = "#56B4E9"  # Okabe-Ito blue
WEEKLY_COLOR = "#E69F00"  # Okabe-Ito orange

ID = "grok"
LABEL = "Grok"

BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing"
CREDITS_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig"
USER_AGENT = "GrokUsageExtension/1.0"


def default_auth_path() -> Path:
    return Path.home() / ".grok" / "auth.json"


def _date_parse_ms(s) -> float | None:
    """new Date(s).getTime() equivalent; None (not NaN) when unparseable."""
    if not isinstance(s, str):
        return None
    try:
        return _dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000
    except Exception:
        return None


# ~/.grok/auth.json is keyed by issuer::client_id -> { key, refresh_token,
# expires_at, ... }. Prefer a non-expired entry; fall back progressively.
# Ported from extension.js:973-994.
def extract_token(auth_obj):
    if not isinstance(auth_obj, dict):
        return None
    now = time.time() * 1000
    fallback = None
    for v in auth_obj.values():
        if not isinstance(v, dict) or not v.get("key"):
            continue
        if fallback is None:
            fallback = v["key"]
        if v.get("expires_at"):
            exp = _date_parse_ms(v["expires_at"])
            if exp is not None and exp > now:
                return v["key"]
        else:
            return v["key"]
    return fallback or auth_obj.get("key") or auth_obj.get("access_token") or None


# Ported from extension.js:996-1004.
def extract_expiry(auth_obj):
    if not isinstance(auth_obj, dict):
        return None
    for v in auth_obj.values():
        if isinstance(v, dict) and v.get("expires_at"):
            return v["expires_at"]
    return auth_obj.get("expires_at") or None


# Monthly billing fields may arrive as bare scalars or wrapped { val: x }.
def _val_of(x):
    if x is None:
        return None
    if isinstance(x, dict) and "val" in x:
        return x["val"]
    return x
# --- gRPC-web / protobuf helpers for GetGrokCreditsConfig (CodexBar-compatible) ---
# Ported verbatim from extension.js:100-281 (plain JS, no GJS dependency).


def _read_varint(data: bytes, i: int):
    """Returns (value, new_index); value None on truncation/overlong."""
    value = 0
    shift = 0
    while i < len(data) and shift < 35:
        b = data[i]
        i += 1
        value |= (b & 0x7F) << shift
        if (b & 0x80) == 0:
            return value & 0xFFFFFFFF, i  # JS value >>> 0
        shift += 7
    return None, i


def _grpc_web_data_frames(data: bytes):
    frames = []
    i = 0
    while i + 5 <= len(data):
        flags = data[i]
        length = (data[i + 1] << 24) | (data[i + 2] << 16) | (data[i + 3] << 8) | data[i + 4]
        start = i + 5
        end = start + length
        if length < 0 or end > len(data):
            return None
        if (flags & 0x80) == 0:
            frames.append(data[start:end])
        i = end
    return frames


def _looks_like_protobuf(data: bytes) -> bool:
    if not data or len(data) == 0:
        return False
    first = data[0]
    field_number = first >> 3
    wire_type = first & 0x07
    return field_number > 0 and wire_type in (0, 1, 2, 5)


# Scan protobuf (nested up to depth 4) for fixed32 floats and varints.
# Port of CodexBar GrokWebBillingFetcher.scanProtobuf.
def _scan_protobuf(data: bytes, depth=0, prefix=None, order=None):
    fixed32: list[dict] = []
    varints: list[dict] = []
    if prefix is None:
        prefix = []
    i = 0
    while i < len(data):
        field_start = i
        key, i = _read_varint(data, i)
        if key is None or key == 0:
            i = field_start + 1
            continue
        field_number = key >> 3
        wire_type = key & 0x07
        field_path = prefix + [field_number]

        if wire_type == 0:
            value, i = _read_varint(data, i)
            if value is None:
                i = field_start + 1
                continue
            varints.append({"path": field_path, "value": value})
        elif wire_type == 1:
            if i + 8 > len(data):
                break
            i += 8
        elif wire_type == 2:
            length, i = _read_varint(data, i)
            if length is None or i + length > len(data):
                i = field_start + 1
                continue
            start = i
            end = start + length
            if depth < 4:
                nested = _scan_protobuf(data[start:end], depth + 1, field_path, order)
                fixed32.extend(nested["fixed32"])
                varints.extend(nested["varints"])
            i = end
        elif wire_type == 5:
            if i + 4 > len(data):
                break
            value = struct.unpack_from("<f", data, i)[0]
            fixed32.append({"path": field_path, "value": value, "order": order["n"]})
            order["n"] += 1
            i += 4
        else:
            i = field_start + 1
    return {"fixed32": fixed32, "varints": varints}


# Parse GetGrokCreditsConfig response bytes -> { usedPercent, resetsAtMs } | None.
# Ported from extension.js:207-281.
def parse_grok_credits_config(raw_bytes):
    if not raw_bytes or len(raw_bytes) == 0:
        return None
    data = bytes(raw_bytes)

    payloads = _grpc_web_data_frames(data)
    if not payloads:
        if _looks_like_protobuf(data):
            payloads = [data]
        else:
            return None

    all_fixed: list[dict] = []
    all_varint: list[dict] = []
    order = {"n": 0}
    for payload in payloads:
        scan = _scan_protobuf(payload, 0, [], order)
        all_fixed.extend(scan["fixed32"])
        all_varint.extend(scan["varints"])

    # credit_usage_percent: fixed32 float 0-100, field number ending in 1;
    # prefer shallower paths (CodexBar: min path length, then order).
    percent_candidates = [
        f
        for f in all_fixed
        if f["path"]
        and f["path"][-1] == 1
        and math.isfinite(f["value"])
        and 0 <= f["value"] <= 100
    ]
    percent_candidates.sort(key=lambda f: (len(f["path"]), f["order"]))
    used_percent = percent_candidates[0]["value"] if percent_candidates else None

    # Reset: prefer path [1, 5, 1] (period end), else soonest future unix ts.
    now_sec = time.time()
    ts_fields = [f for f in all_varint if 1_700_000_000 <= f["value"] <= 2_100_000_000]
    future = [f for f in ts_fields if f["value"] > now_sec]
    resets_at_sec = None
    preferred = next(
        (
            f
            for f in future
            if len(f["path"]) == 3 and f["path"][0] == 1 and f["path"][1] == 5 and f["path"][2] == 1
        ),
        None,
    )
    if preferred:
        resets_at_sec = preferred["value"]
    elif future:
        resets_at_sec = min(f["value"] for f in future)

    # proto3 omits zero floats — period present + no % -> 0% used.
    has_usage_period = any(
        (len(f["path"]) >= 2 and f["path"][0] == 1 and f["path"][1] == 6)
        or (
            len(f["path"]) == 3
            and f["path"][0] == 1
            and f["path"][1] == 8
            and f["path"][2] == 1
            and f["value"] in (1, 2)
        )
        for f in all_varint
    )
    if used_percent is None and not all_fixed and resets_at_sec is not None and has_usage_period:
        used_percent = 0

    if used_percent is None:
        return None

    return {
        "usedPercent": used_percent,
        "resetsAtMs": resets_at_sec * 1000 if resets_at_sec is not None else None,
    }


# Pure function of the combined envelope text — no fs/network.
#   raw = '{"billing":"<monthly json text>","credits":"<base64|null>"}'
# Monthly drives validity (mirrors claude: a body that isn't a usage response
# raises AuthExpiredError). Weekly is best-effort: absent/unparseable credits
# yield a weekly window with null pct rather than failing the whole snapshot.
def parse(raw) -> dict:
    try:
        envelope = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise AuthExpiredError("unparseable grok envelope")
    if not isinstance(envelope, dict):
        raise AuthExpiredError("unparseable grok envelope")

    # --- monthly ---
    try:
        billing = json.loads(envelope.get("billing") or "")
    except Exception:
        raise AuthExpiredError("unparseable billing response")
    cfg = (
        billing.get("config")
        if isinstance(billing, dict) and isinstance(billing.get("config"), dict)
        else billing
    )
    used = _val_of(cfg.get("used")) if isinstance(cfg, dict) else None
    limit = _val_of(cfg.get("monthlyLimit")) if isinstance(cfg, dict) else None
    # used missing/unparseable = auth actually broken. limit === 0 or missing
    # is a real plan state (no monthly-included cap — usage tracked by weekly
    # credits/on-demand instead), not an auth failure; emit pct None rather
    # than failing the whole snapshot (same "no limit" convention mistral uses
    # for its monthly_spend window).
    if used is None:
        raise AuthExpiredError()

    def _finite(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool)

    monthly = {
        "id": "monthly",
        "label": "Monthly",
        "letter": "Mo",
        "pct": (100 * used) / limit if _finite(limit) and limit > 0 else None,
        "resets_at": cfg.get("billingPeriodEnd") if isinstance(cfg, dict) else None,
        "color": MONTHLY_COLOR,
        "will_deplete": False,
    }

    # --- weekly (best-effort) ---
    weekly_pct = None
    weekly_resets = None
    if envelope.get("credits"):
        try:
            creds_bytes = base64.b64decode(envelope["credits"])
            parsed_week = parse_grok_credits_config(creds_bytes)
            if parsed_week:
                weekly_pct = parsed_week["usedPercent"]
                if parsed_week["resetsAtMs"] is not None:
                    weekly_resets = (
                        _dt.datetime.fromtimestamp(
                            parsed_week["resetsAtMs"] / 1000, _dt.timezone.utc
                        )
                        .isoformat()
                        .replace(".000", "")
                        .replace("+00:00", "Z")
                    )
        except Exception:
            weekly_pct = None
            weekly_resets = None
    weekly = {
        "id": "weekly",
        "label": "Weekly",
        "letter": "Wk",
        "pct": weekly_pct,
        "resets_at": weekly_resets,
        "color": WEEKLY_COLOR,
        "will_deplete": False,
    }

    # shorter-window-first, matching claude/ollama ([session, weekly]) — array
    # order IS display order, no renderer sorts by duration.
    return {"tier": None, "windows": [weekly, monthly], "segments": []}


def create() -> dict:
    state = {
        "auth_path": default_auth_path(),
        "last_token_expires_at": None,  # surfaced via meta() — set on each auth read
    }

    def config() -> dict:
        return {
            "id": ID,
            "label": LABEL,
            "usageUrl": "https://grok.com/?_s=usage",
            # path/relogin let a client explain an auth_expired instead of just
            # showing it: this token is read straight from the Grok CLI's own
            # file and never refreshed here, so re-login IS the fix.
            "auth": {
                "kind": "oauth-file",
                "path": str(state["auth_path"]),
                "relogin": "grok login",
            },
            "windows": [
                {"id": "monthly", "label": "Monthly", "color": MONTHLY_COLOR},
                {"id": "weekly", "label": "Weekly", "color": WEEKLY_COLOR},
            ],
            "tiers": [],
        }

    def configure(cfg: dict | None = None) -> None:
        cfg = cfg or {}
        p = cfg.get("authPath") or cfg.get("auth_path")
        if p:
            state["auth_path"] = Path(p).expanduser()

    async def set_auth(payload: str) -> None:
        import asyncio

        p = state["auth_path"]

        def _write():
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(payload + "\n")
            p.chmod(0o600)

        await asyncio.to_thread(_write)

    async def fetch() -> str:
        import asyncio

        auth_path = state["auth_path"]

        def _read():
            return json.loads(auth_path.read_text())

        try:
            auth_obj = await asyncio.to_thread(_read)
        except Exception:
            raise AuthExpiredError("no Grok auth file found (run `grok login`)")
        token = extract_token(auth_obj)
        state["last_token_expires_at"] = extract_expiry(auth_obj)
        if not token:
            raise AuthExpiredError("no token in ~/.grok/auth.json")

        headers = {
            "Authorization": f"Bearer {token}",
            "User-Agent": USER_AGENT,
        }

        # Monthly — authoritative for error state.
        c = create_client()
        try:
            billing_res = await c.get(
                BILLING_URL, headers={**headers, "Accept": "application/json"}
            )
        finally:
            await c.aclose()
        if billing_res.status_code == 401:
            raise AuthExpiredError()
        if billing_res.status_code == 429:
            ra = billing_res.headers.get("retry-after")
            raise RateLimitedError(int(ra) if ra and ra.isdigit() else None)
        if billing_res.status_code >= 400:
            raise ProviderError(f"cli-chat-proxy.grok.com HTTP {billing_res.status_code}")
        billing = billing_res.text

        # Weekly — best-effort; any failure leaves credits None, never raises.
        credits = None
        try:
            c = create_client()
            try:
                weekly_res = await c.post(
                    CREDITS_URL,
                    headers={
                        **headers,
                        "Content-Type": "application/grpc-web+proto",
                        "x-grpc-web": "1",
                        "x-user-agent": "connect-es/2.1.1",
                        "Origin": "https://grok.com",
                        "Referer": "https://grok.com/?_s=usage",
                        "Accept": "*/*",
                    },
                    # Empty gRPC-web data frame (5 zero bytes).
                    content=bytes([0, 0, 0, 0, 0]),
                )
            finally:
                await c.aclose()
            if weekly_res.status_code < 400:
                credits = base64.b64encode(weekly_res.content).decode()
        except Exception:
            credits = None

        return json.dumps({"billing": billing, "credits": credits})

    def interval_seconds() -> int:
        return 300

    return {
        "id": ID,
        "label": LABEL,
        "auth": {"kind": "oauth-file"},
        "config": config,
        "configure": configure,
        "set_auth": set_auth,
        "fetch": fetch,
        "interval_seconds": interval_seconds,
        "meta": lambda: {"token_expires_at": state["last_token_expires_at"]},
        "parse": parse,
    }

