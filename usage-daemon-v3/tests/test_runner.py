"""Port of test/runner.test.js — scheduling policy, poll lifecycle, auth plumbing.

Fake providers are injected via runner.add() exactly as the JS tests do; no
network. The store defaults to a real Store writing into a tmp state dir.
"""

import asyncio
import os
import stat
import tempfile

import pytest

from usage_daemon.errors import AuthExpiredError, RateLimitedError
from usage_daemon.runner import Runner, next_delay

BASE = 300_000  # 5 min

_tmp = tempfile.mkdtemp(prefix="usage-daemon-test-")
os.environ.setdefault("USAGE_STATE_DIR", _tmp)  # read by Store() default path


def _stub_cookie_provider(cookie_state):
    """Port of stubProvider(): configure-able cookie provider."""

    def configure(cfg=None, _s=cookie_state):
        if cfg and "cookie" in cfg:
            _s["cookie"] = cfg["cookie"]

    async def fetch():
        if not cookie_state["cookie"]:
            raise AuthExpiredError("no cookie")
        return 'Cloud usage <span class="capitalize">free</span>'

    def parse(raw):
        return {
            "tier": "free",
            "windows": [
                {
                    "id": "session",
                    "label": "Session",
                    "pct": 5,
                    "resets_at": None,
                    "color": "#E69F00",
                    "will_deplete": False,
                }
            ],
            "segments": [],
        }

    return {
        "id": "stub",
        "label": "Stub Provider",
        "auth": {"kind": "cookie"},
        "configure": configure,
        "fetch": fetch,
        "parse": parse,
    }


def _token_stub_provider(token_state):
    """Port of tokenStubProvider(): setAuth token provider, no configure()."""

    async def set_auth(t):
        token_state["token"] = t.strip() if t else None

    async def fetch():
        if not token_state["token"]:
            raise AuthExpiredError("no token")
        return "ok"

    def parse(raw):
        return {
            "tier": None,
            "windows": [
                {"id": "x", "label": "X", "pct": 1, "resets_at": None, "color": "#000", "will_deplete": False}
            ],
            "segments": [],
        }

    return {
        "id": "stub",
        "label": "Token Stub",
        "auth": {"kind": "token"},
        "set_auth": set_auth,
        "fetch": fetch,
        "parse": parse,
    }


# --- nextDelay: pure scheduling policy ---


def test_next_delay_ok_returns_base():
    assert next_delay("ok", 0, None, BASE) == BASE


def test_next_delay_rate_limited_honors_retry_after():
    assert next_delay("rate_limited", 1, 600, BASE) == 600_000
    assert next_delay("rate_limited", 1, 10, BASE) == BASE  # floored to base


def test_next_delay_error_backs_off_exponentially():
    assert next_delay("error", 1, None, BASE) == BASE
    assert next_delay("error", 2, None, BASE) == 2 * BASE
    assert next_delay("error", 3, None, BASE) == 4 * BASE
    assert next_delay("error", 99, None, BASE) == 60 * 60 * 1000  # capped at 1h


def test_next_delay_auth_expired_uses_slow_recheck():
    assert next_delay("auth_expired", 5, None, BASE) == 30 * 60 * 1000


# --- poll lifecycle ---


def test_poll_in_flight_guard_dedupes_concurrent_polls():
    state = {"fetches": 0}

    async def fetch():
        state["fetches"] += 1
        await asyncio.sleep(0.03)
        return "x"

    def parse(raw):
        return {"tier": None, "windows": [], "segments": []}

    async def main():
        runner = Runner()
        runner.add({"id": "slow", "label": "Slow", "auth": {"kind": "cookie"}, "fetch": fetch, "parse": parse})
        a, b = await asyncio.gather(runner.poll("slow"), runner.poll("slow"))
        assert state["fetches"] == 1, "second call rode the first fetch"
        assert a is b, "same snapshot object"

    asyncio.run(main())


def test_poll_failure_then_recovery_clears_failures():
    state = {"ok": False}

    async def fetch():
        if not state["ok"]:
            raise RuntimeError("down")
        return "x"

    def parse(raw):
        return {"tier": None, "windows": [], "segments": []}

    async def main():
        runner = Runner()
        runner.add({"id": "flap", "label": "Flap", "auth": {"kind": "cookie"}, "fetch": fetch, "parse": parse})
        bad = await runner.poll("flap")
        assert bad["status"] == "error"
        assert runner.providers["flap"]["failures"] == 1
        state["ok"] = True
        good = await runner.poll("flap")
        assert good["status"] == "ok"
        assert runner.providers["flap"]["failures"] == 0
        assert runner.providers["flap"]["last_success_t"] > 0

    asyncio.run(main())


def test_poll_manual_bypasses_rate_limit_gate_scheduled_respects_it():
    state = {"fetches": 0}

    async def fetch():
        state["fetches"] += 1
        raise RateLimitedError(600)

    def parse(raw):
        return {"tier": None, "windows": [], "segments": []}

    async def main():
        import time

        runner = Runner()
        runner.add({"id": "throttled", "label": "Throttled", "auth": {"kind": "cookie"}, "fetch": fetch, "parse": parse})
        runner.providers["throttled"]["scheduled"] = True  # arm _reschedule, as start() would

        first = await runner.poll("throttled")
        assert first["status"] == "rate_limited"
        assert state["fetches"] == 1
        assert runner.providers["throttled"]["next_poll_at"] > time.time() * 1000

        # Scheduled/background poll before next_poll_at: gate holds, no re-fetch.
        cached = await runner.poll("throttled")
        assert state["fetches"] == 1
        assert cached is first

        # Manual (user-initiated) poll: bypasses the gate, re-fetches immediately.
        manual = await runner.poll("throttled", manual=True)
        assert state["fetches"] == 2
        assert manual["status"] == "rate_limited"

    asyncio.run(main())


# --- cookie persistence ---


def test_set_cookie_persists_0600_reconfigures_re_polls():
    cookie_state = {"cookie": None}
    cookie_file = os.path.join(_tmp, "stub.cookie")

    async def main():
        runner = Runner()
        runner.add(_stub_cookie_provider(cookie_state), {"cookieFile": cookie_file})

        before = await runner.poll("stub")
        assert before["status"] == "auth_expired"
        assert before["stale"] is True

        snap = await runner.set_cookie("stub", "  session=abc123  ")
        assert snap["status"] == "ok"
        assert snap["stale"] is False
        assert snap["windows"][0]["pct"] == 5

        with open(cookie_file) as f:
            assert f.read() == "session=abc123\n"
        assert stat.S_IMODE(os.stat(cookie_file).st_mode) == 0o600

    asyncio.run(main())


def test_set_cookie_empty_rejected():
    async def main():
        runner = Runner()
        runner.add(_stub_cookie_provider({"cookie": None}), {"cookieFile": os.path.join(_tmp, "x.cookie")})
        with pytest.raises(ValueError, match="empty cookie"):
            await runner.set_cookie("stub", "   ")

    asyncio.run(main())


def test_clear_cookie_removes_file_and_re_polls():
    cookie_file = os.path.join(_tmp, "flush.cookie")
    cookie_state = {"cookie": None}

    async def main():
        runner = Runner()
        runner.add(_stub_cookie_provider(cookie_state), {"cookieFile": cookie_file})

        ok = await runner.set_cookie("stub", "session=abc123")
        assert ok["status"] == "ok"
        with open(cookie_file) as f:
            assert f.read() == "session=abc123\n"

        flushed = await runner.clear_cookie("stub")
        assert flushed["status"] == "auth_expired"
        assert flushed["stale"] is True
        assert not os.path.exists(cookie_file)

    asyncio.run(main())


# --- token persistence ---


def test_set_auth_payload_persists_token_0600():
    token_state = {"token": None}
    auth_file = os.path.join(_tmp, "stub.token")

    async def main():
        runner = Runner()
        runner.add(_token_stub_provider(token_state), {"authFile": auth_file})

        before = await runner.poll("stub")
        assert before["status"] == "auth_expired"

        snap = await runner.set_auth_payload("stub", "  tok-abc123  ")
        assert snap["status"] == "ok"

        with open(auth_file) as f:
            assert f.read() == "tok-abc123\n"
        assert stat.S_IMODE(os.stat(auth_file).st_mode) == 0o600

    asyncio.run(main())


def test_clear_auth_removes_auth_file_and_re_polls():
    auth_file = os.path.join(_tmp, "clear.token")
    token_state = {"token": None}

    async def main():
        runner = Runner()
        runner.add(_token_stub_provider(token_state), {"authFile": auth_file})

        await runner.set_auth_payload("stub", "tok-abc123")
        with open(auth_file) as f:
            assert f.read() == "tok-abc123\n"

        flushed = await runner.clear_auth("stub")
        assert flushed["status"] == "auth_expired"
        assert not os.path.exists(auth_file)

    asyncio.run(main())


def test_set_auth_payload_without_auth_file_is_memory_only():
    token_state = {"token": None}

    async def main():
        runner = Runner()
        runner.add(_token_stub_provider(token_state))  # no authFile
        snap = await runner.set_auth_payload("stub", "tok-abc123")
        assert snap["status"] == "ok"  # still works live, just not persisted

    asyncio.run(main())
