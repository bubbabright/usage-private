"""The runner (port of src/runner.js).

Schedules each configured provider on its own interval, normalizes its raw
parse into the A2 snapshot, stores history, and keeps the last-known snapshot
per provider (fail-soft: errors mark stale, never blank).
"""

from __future__ import annotations

import asyncio
import copy
import random
import time as _time

from . import sqlite_store as _store
from .cookiejar import cookie_header_for
from .errors import code_of, AuthExpiredError, RateLimitedError
from .history_utils import find_activity_base
from .log import log
from .timeutil import to_host_iso

STATUS = {
    "OK": "ok",
    "AUTH_EXPIRED": "auth_expired",
    "RATE_LIMITED": "rate_limited",
    "ERROR": "error",
}

MAX_BACKOFF_MS = 60 * 60 * 1000
AUTH_RECHECK_MS = 30 * 60 * 1000
FETCH_TIMEOUT_MS = 30 * 1000
ACTIVITY_WINDOW_MS = 60 * 60 * 1000


def now_ms() -> int:
    return int(_time.time() * 1000)


def next_delay(status: str, failures: int, retry_after, base_ms: int) -> int:
    """Pure scheduling policy: how long until the next poll, given last outcome."""
    if status == STATUS["OK"]:
        return base_ms
    if retry_after is not None and retry_after > 0:
        return max(int(retry_after) * 1000, base_ms)
    if status == STATUS["AUTH_EXPIRED"]:
        return max(AUTH_RECHECK_MS, base_ms)
    n = max(0, (failures if failures is not None else 1) - 1)
    exp = base_ms * (2 ** min(n, 12))
    return min(max(exp, base_ms), MAX_BACKOFF_MS)


def _parse_burn_amount(amount_str: str) -> float:
    """Strip an optional trailing '%' and parse the number. Caller decides what the number means."""
    s = str(amount_str or "").strip()
    if not s:
        raise ValueError("empty amount")
    return float(s[:-1] if s.endswith("%") else s)


def jitter(ms: int) -> int:
    """Up to +10% (max +30s) positive jitter so backoffs don't lockstep."""
    return random.randrange(0, int(min(ms * 0.1, 30_000)))


async def _with_timeout(awaitable, ms: int, label: str):
    try:
        return await asyncio.wait_for(awaitable, timeout=ms / 1000.0)
    except asyncio.TimeoutError:
        raise RuntimeError(f"{label} fetch timed out after {ms}ms")


class Runner:
    def __init__(self, store=None):
        self.providers: dict[str, dict] = {}  # name -> entry
        self.current: dict[str, dict] = {}  # name -> snapshot
        self.store = store or _store.Store()

    def add(self, provider: dict, meta: dict | None = None):
        meta = meta or {}
        name = provider["id"]
        self.providers[name] = {
            "provider": provider,
            "timer": None,
            "cookieFile": meta.get("cookieFile"),
            "authFile": meta.get("authFile"),
            "cookieFromFirefox": meta.get("cookieFromFirefox"),
            "scheduled": False,
            "inFlight": None,
            "failures": 0,
            "retryAfter": None,
            "last_success_t": None,
            "lastFirefoxCookie": None,
            "firefoxRecovery": False,
            "cookieExpiresAt": None,
            "next_poll_at": None,
            "backoff_ms": None,
        }

    # --- cookie / auth persistence ---
    def _entry(self, name: str) -> dict:
        e = self.providers.get(name)
        if e is None:
            raise KeyError(f"unknown provider: {name}")
        return e

    async def set_cookie(self, name: str, cookie: str) -> dict:
        e = self._entry(name)
        value = str(cookie or "").strip()
        if not value:
            raise ValueError("empty cookie")
        if e.get("cookieFile"):
            await asyncio.to_thread(_write_file, e["cookieFile"], value)
        await self.store.async_secret_set(name, "cookie", value)
        configure = e["provider"].get("configure")
        if configure:
            configure({"cookie": value})
        return await self.poll(name, manual=True)

    async def set_auth_payload(self, name: str, payload: str) -> dict:
        e = self._entry(name)
        value = str(payload or "").strip()
        if not value:
            raise ValueError("empty payload")
        set_auth = e["provider"].get("set_auth")
        if set_auth:
            await set_auth(value)
        if e.get("authFile"):
            await asyncio.to_thread(_write_file, e["authFile"], value)
        await self.store.async_secret_set(name, "auth", value)
        return await self.poll(name, manual=True)

    async def clear_cookie(self, name: str) -> dict:
        e = self._entry(name)
        if e.get("cookieFile"):
            await asyncio.to_thread(_rm_file, e["cookieFile"])
        await self.store.async_secret_delete(name, "cookie")
        configure = e["provider"].get("configure")
        if configure:
            configure({"cookie": ""})
        return await self.poll(name, manual=True)

    async def clear_auth(self, name: str) -> dict:
        e = self._entry(name)
        set_auth = e["provider"].get("set_auth")
        if set_auth:
            await set_auth("")
        configure = e["provider"].get("configure")
        if configure:
            configure({"api_key": ""})
        if e.get("authFile"):
            await asyncio.to_thread(_rm_file, e["authFile"])
        await self.store.async_secret_delete(name, "auth")
        return await self.poll(name, manual=True)

    async def refresh_cookie_from_firefox(self, name: str) -> dict:
        e = self._entry(name)
        domain = e.get("cookieFromFirefox")
        if not domain:
            raise RuntimeError(f"{name} has no cookie_from_firefox domain configured")
        res = cookie_header_for(domain)
        if not res["header"]:
            raise RuntimeError(f"no live cookies for {domain} in Firefox — log in to it there first")
        e["cookieExpiresAt"] = res.get("expiresAt")
        log.info("cookie refreshed from firefox", {
            "provider": name, "domain": domain, "profile": res.get("profile"),
            "cookies": res["count"], "names": ",".join(res["names"]),
            "expires_at": res.get("expiresAt") or "session-only",
        })
        snap = await self.set_cookie(name, res["header"])
        if snap.get("status") != STATUS["OK"]:
            raise RuntimeError(f"fresh cookie for {domain} still {snap.get('status')} — is it the right account?")
        return snap

    # --- introspection ---
    def list(self) -> list[dict]:
        out = []
        for name in self.providers:
            snap = self.current.get(name)
            entry = self.providers[name]
            cfg = entry["provider"].get("config") or (lambda: {})
            windows = [
                {
                    "id": w.get("id"),
                    "label": w.get("label") or w.get("id"),
                    "letter": w.get("letter"),
                    "pct": w.get("pct") if isinstance(w.get("pct"), (int, float)) else None,
                    "used": w.get("used") if isinstance(w.get("used"), (int, float)) else None,
                    "used_is_remaining": bool(w.get("used_is_remaining")),
                    "cap": w.get("cap") if isinstance(w.get("cap"), (int, float)) else None,
                    "unit": w.get("unit"),
                    "color": w.get("color"),
                    "cycles_remaining": (
                        w.get("cycles_remaining") if isinstance(w.get("cycles_remaining"), (int, float)) else None
                    ),
                    "resets_at": w.get("resets_at"),
                    "pct_1h_ago": (
                        w.get("pct_1h_ago") if isinstance(w.get("pct_1h_ago"), (int, float)) else None
                    ),
                }
                for w in (snap or {}).get("windows", [])
            ]
            out.append({
                "provider": name,
                "status": (snap or {}).get("status", "pending"),
                "stale": (snap or {}).get("stale", True),
                "t": (snap or {}).get("t"),
                "tier": (snap or {}).get("tier"),
                "error": (snap or {}).get("error"),
                "last_success_t": entry.get("last_success_t"),
                "consecutive_failures": entry.get("failures", 0),
                "next_poll_at": entry.get("next_poll_at"),
                "cookie_from_firefox": entry.get("cookieFromFirefox"),
                "cookie_expires_at": entry.get("cookieExpiresAt"),
                "category": (cfg() or {}).get("category", "plan"),
                "windows": windows,
                "segments": (snap or {}).get("segments", []),
            })
        return out

    def get_current(self, name: str):
        return self.current.get(name)

    async def get_history(self, name: str) -> list[dict]:
        return await self.store.async_read(name)

    # --- burn (artificially inject usage, for testing display/polling) ---
    def _empty_snapshot(self, name: str) -> dict:
        """A zeroed snapshot for a provider with no real poll yet, so it can still be burned."""
        e = self._entry(name)
        cfg = (e["provider"].get("config") or (lambda: {}))() or {}
        windows = [
            {
                "id": w.get("id"),
                "label": w.get("label", w.get("id")),
                "letter": None,
                "pct": None,
                "used": 0,
                "used_is_remaining": False,
                "cap": None,
                "unit": None,
                "color": w.get("color"),
                "resets_at": None,
            }
            for w in cfg.get("windows", [])
        ]
        return {
            "provider": name,
            "t": now_ms(),
            "tier": None,
            "status": STATUS["OK"],
            "stale": False,
            "windows": windows,
            "segments": [],
        }

    def burn(self, name: str, amount_str: str, window_id: str | None = None) -> dict:
        """Immediately inject fake usage into a provider's current snapshot.

        Only ever touches `self.current[name]` — the same field a real poll
        unconditionally overwrites (`_do_poll`) — so the very next real poll
        (on schedule, or via `poll(name, manual=True)`) naturally replaces it
        with real data. No history/store write, no scheduler change.
        """
        self._entry(name)
        snap = copy.deepcopy(self.current.get(name)) or self._empty_snapshot(name)
        windows = snap.get("windows") or []
        if window_id:
            target = next((w for w in windows if w.get("id") == window_id), None)
            if target is None:
                raise ValueError(f"unknown window: {window_id}")
        else:
            target = windows[0] if windows else None
        if target is None:
            raise ValueError(f"no window to burn on {name}")

        delta = _parse_burn_amount(amount_str)
        is_percent = str(amount_str).strip().endswith("%")
        cap = target.get("cap")
        has_cap = isinstance(cap, (int, float)) and cap > 0

        if has_cap:
            amount = (delta / 100.0 * cap) if is_percent else delta
            if target.get("used_is_remaining"):
                target["used"] = max(0.0, (target.get("used") or 0) - amount)
            else:
                target["used"] = (target.get("used") or 0) + amount
            used_for_pct = (cap - target["used"]) if target.get("used_is_remaining") else target["used"]
            target["pct"] = max(0.0, min(100.0, 100.0 * used_for_pct / cap))
        elif isinstance(target.get("pct"), (int, float)):
            # No cap to anchor units to: both "5" and "5%" mean "+5 percentage points".
            target["pct"] = max(0.0, min(100.0, target["pct"] + delta))
        else:
            target["used"] = (target.get("used") or 0) + delta

        snap["windows"] = windows
        self.current[name] = snap
        return snap

    # --- schedule ---
    def start(self) -> None:
        for name in list(self.providers):
            e = self.providers[name]
            e["scheduled"] = True
            asyncio.create_task(self.poll(name))

    def stop(self) -> None:
        for e in self.providers.values():
            e["scheduled"] = False
            t = e.get("timer")
            if t:
                t.cancel()
            e["timer"] = None

    def _reschedule(self, name: str) -> None:
        e = self.providers.get(name)
        if not e or not e["scheduled"]:
            return
        snap = self.current.get(name)
        base = (e["provider"].get("interval_seconds", lambda: 300)() or 300) * 1000
        status = (snap or {}).get("status", STATUS["ERROR"])
        delay = next_delay(status, e["failures"], e["retryAfter"], base) + jitter(base)
        e["backoff_ms"] = delay
        e["next_poll_at"] = now_ms() + delay
        t = e.get("timer")
        if t:
            t.cancel()

        async def _fire():
            await asyncio.sleep(delay / 1000.0)
            if e["scheduled"]:
                await self.poll(name)

        e["timer"] = asyncio.create_task(_fire())

    async def poll(self, name: str, manual: bool = False) -> dict | None:
        e = self._entry(name)
        cur = self.current.get(name)
        if (
            not manual
            and cur
            and cur.get("status") == STATUS["RATE_LIMITED"]
            and e.get("retryAfter")
            and e.get("next_poll_at")
            and now_ms() < e["next_poll_at"]
        ):
            return cur
        if e.get("inFlight"):
            return await e["inFlight"]
        task = asyncio.create_task(self._do_poll(name))
        e["inFlight"] = task
        try:
            return await task
        finally:
            e["inFlight"] = None
            self._reschedule(name)

    async def _do_poll(self, name: str) -> dict:
        e = self._entry(name)
        provider = e["provider"]
        t = now_ms()
        try:
            raw = await _with_timeout(provider["fetch"](), FETCH_TIMEOUT_MS, name)
            parsed = provider["parse"](raw)

            # Optional provider-specific enrichment (hyper: dashboard -> resets/tier/segments).
            enrich = provider.get("fetch_dashboard")
            if enrich:
                try:
                    dash = await enrich()
                    if dash and provider.get("parse_dashboard"):
                        d = provider["parse_dashboard"](dash)
                        if d.get("resets_at") and parsed.get("windows"):
                            parsed["windows"][0]["resets_at"] = d["resets_at"]
                        if d.get("tier"):
                            parsed["tier"] = d["tier"]
                        if d.get("segments"):
                            parsed["segments"] = d["segments"]
                except Exception:
                    pass  # enrichment is best-effort

            history = await self.store.async_read(name)
            windows = []
            for w in parsed.get("windows", []):
                resets_at = to_host_iso(w.get("resets_at"))
                w_pct = w.get("pct")
                base = (
                    find_activity_base(history, w["id"], t, ACTIVITY_WINDOW_MS)
                    if isinstance(w_pct, (int, float))
                    else None
                )
                pct_1h_ago = base["value"] if base and base["value"] <= w_pct else None
                window = {k: v for k, v in w.items() if k != "will_deplete"}
                windows.append({
                    **window,
                    "resets_at": resets_at,
                    "pct_1h_ago": pct_1h_ago,
                })

            meta = dict(provider.get("meta", lambda: {})() or {})
            if meta.get("token_expires_at"):
                meta["token_expires_at"] = to_host_iso(meta["token_expires_at"])

            snapshot = {
                "provider": name,
                "t": t,
                "tier": parsed.get("tier"),
                "status": STATUS["OK"],
                "stale": False,
                "windows": windows,
                "segments": parsed.get("segments") or [],
                **meta,
            }
            if e["failures"] > 0:
                log.info("provider recovered", {"provider": name, "after_failures": e["failures"]})
            e["failures"] = 0
            e["retryAfter"] = None
            e["last_success_t"] = t
            self.current[name] = snapshot
            await self.store.async_append(name, snapshot)
            return snapshot

        except Exception as err:
            return await self._recover_or_stale(name, t, err)

    async def _recover_or_stale(self, name: str, t: int, err: Exception) -> dict:
        e = self._entry(name)
        # Self-heal an expired session once via Firefox, only while a provider is
        # otherwise broken (never on a healthy path).
        if (
            code_of(err) == "auth_expired"
            and e.get("cookieFromFirefox")
            and not e.get("firefoxRecovery")
        ):
            e["firefoxRecovery"] = True
            try:
                fresh = cookie_header_for(e["cookieFromFirefox"])
                if fresh["header"] and fresh["header"] != e.get("lastFirefoxCookie"):
                    e["lastFirefoxCookie"] = fresh["header"]
                    e["cookieExpiresAt"] = fresh.get("expiresAt")
                    e["provider"]["configure"]({"cookie": fresh["header"]})
                    if e.get("cookieFile"):
                        await asyncio.to_thread(_write_file, e["cookieFile"], fresh["header"])
                    await self.store.async_secret_set(name, "cookie", fresh["header"])
                    log.info("auth_expired: found a newer cookie in firefox, retrying poll", {
                        "provider": name, "domain": e["cookieFromFirefox"],
                        "cookies": fresh["count"],
                        "expires_at": fresh.get("expiresAt") or "session-only",
                    })
                    return await self._do_poll(name)
            except Exception as recovery_err:
                log.warn("auth_expired: firefox recovery attempt failed", {
                    "provider": name, "domain": e["cookieFromFirefox"], "err": recovery_err,
                })
            finally:
                e["firefoxRecovery"] = False
        return await self._mark_stale(name, t, err)

    async def _mark_stale(self, name: str, t: int, err: Exception) -> dict:
        prev = self.current.get(name)
        status = code_of(err)
        e = self.providers.get(name)
        if e:
            e["failures"] = (e.get("failures") or 0) + 1
            ra = getattr(err, "retryAfter", None)
            e["retryAfter"] = (
                ra if isinstance(ra, (int, float)) and ra > 0 else None
            )
            log.warn("provider poll failed", {
                "provider": name, "status": status,
                "error": str(err) or err.__class__.__name__,
                "consecutive_failures": e["failures"],
                "retry_after_s": e["retryAfter"],
            })

        windows = None
        tier = None
        last_t = None
        if prev and prev.get("windows") is not None:
            windows = prev["windows"]
            tier = prev.get("tier")
            last_t = prev.get("t")
        else:
            history = await self.store.async_read(name)
            if history:
                last_row = history[-1]
                cfg_windows = (e["provider"].get("config") or (lambda: {}))().get("windows", [])
                cfg_by_id = {w["id"]: w for w in cfg_windows}
                windows = [
                    {
                        "id": wid,
                        "label": cfg_by_id.get(wid, {}).get("label", wid),
                        "pct": last_row.get(wid),
                        "resets_at": None,
                        "color": cfg_by_id.get(wid, {}).get("color"),
                    }
                    for wid in last_row
                    if wid not in ("t", "tier")
                ]
                tier = last_row.get("tier", tier)
                last_t = last_row.get("t", last_t)

        snapshot = {
            "provider": name,
            "t": last_t or t,
            "tier": tier or "unknown",
            "status": status,
            "stale": True,
            "error": str(err) or err.__class__.__name__,
            "windows": windows or [],
            "segments": (prev or {}).get("segments", []),
        }
        self.current[name] = snapshot
        return snapshot


def _write_file(path: str, value: str) -> None:
    import os as _os

    p = _os.path.expanduser(path)
    _os.makedirs(_os.path.dirname(p) or ".", exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(value + "\n")
    try:
        _os.chmod(p, 0o600)
    except OSError:
        pass


def _rm_file(path: str) -> None:
    import os as _os

    try:
        _os.remove(_os.path.expanduser(path))
    except OSError:
        pass