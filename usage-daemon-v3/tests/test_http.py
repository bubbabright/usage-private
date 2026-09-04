"""In-process HTTP surface tests (no JS equivalent — v3's ThreadingHTTPServer).

Boots create_server() on port 0 with a real Runner + tmp Store, drives it with
httpx. These pin the seam bugs unit tests can't catch (the serve_forever-class
mistakes) and the route contract: status codes, JSON shapes, metrics text.
"""

import asyncio
import threading
import time
from types import SimpleNamespace

import httpx
import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.http import create_server
from usage_daemon.runner import Runner
from usage_daemon.sqlite_store import Store


def _good_provider(state):
    async def fetch():
        return "raw"

    def parse(raw):
        return {
            "tier": "pro",
            "windows": [
                {
                    "id": "w5h",
                    "label": "5h",
                    "pct": state["pct"],
                    "resets_at": None,
                    "color": "#E69F00",
                    "will_deplete": False,
                }
            ],
            "segments": [],
        }

    def config():
        return {"id": "good", "label": "Good", "windows": [{"id": "w5h", "color": "#E69F00"}]}

    return {
        "id": "good",
        "label": "Good",
        "auth": {"kind": "cookie"},
        "config": config,
        "fetch": fetch,
        "parse": parse,
    }


def _bad_provider():
    async def fetch():
        raise AuthExpiredError("no cookie")

    def parse(raw):
        return {"tier": None, "windows": [], "segments": []}

    return {"id": "bad", "label": "Bad", "auth": {"kind": "cookie"}, "fetch": fetch, "parse": parse}


def _token_provider(state):
    """Token-auth provider for the /auth route contract (mirror of JS token stubs)."""

    async def set_auth(t):
        state["token"] = (t or "").strip() or None

    async def fetch():
        if not state["token"]:
            raise AuthExpiredError("no token")
        return "ok"

    def parse(raw):
        return {
            "tier": "token",
            "windows": [{"id": "x", "label": "X", "pct": 1, "resets_at": None, "color": "#000", "will_deplete": False}],
            "segments": [],
        }

    return {"id": "tok", "label": "Tok", "auth": {"kind": "token"}, "set_auth": set_auth, "fetch": fetch, "parse": parse}


@pytest.fixture()
def api(tmp_path):
    store = Store(state_dir=str(tmp_path / "state"))
    runner = Runner(store=store)
    good_state = {"pct": 42}
    runner.add(_good_provider(good_state), {"cookieFile": str(tmp_path / "good.cookie")})
    runner.add(_bad_provider())
    tok_state = {"token": None}
    runner.add(_token_provider(tok_state), {"authFile": str(tmp_path / "tok.auth")})

    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()

    meta = {
        "version": "test",
        "startedAt": time.time() * 1000,
        "underSystemd": False,
        "control": {"allow_control": False},
    }
    server = create_server(runner, meta, loop=loop, port=0)
    port = server.server_address[1]
    serve_thread = threading.Thread(target=server.serve_forever, daemon=True)
    serve_thread.start()

    def run(coro):
        return asyncio.run_coroutine_threadsafe(coro, loop).result(30)

    async def _initial():
        return await asyncio.gather(runner.poll("good"), runner.poll("bad"))

    run(_initial())
    yield SimpleNamespace(
        base=f"http://127.0.0.1:{port}",
        runner=runner,
        good_state=good_state,
        run=run,
        tmp=tmp_path,
    )

    server.shutdown()
    server.server_close()
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=5)


def test_health_shape(api):
    r = httpx.get(f"{api.base}/usage/health")
    assert r.status_code == 200
    body = r.json()
    assert body["version"] == "test"
    assert body["under_systemd"] is False
    assert body["control"] == {"enabled": False, "restart": False, "stop": False, "start": False}
    assert body["providers"]["total"] == 3
    assert body["providers"]["ok"] == 1  # good
    assert body["providers"]["down"] == 2  # bad + tok (no auth yet)


def test_providers_list_includes_error_snapshot(api):
    r = httpx.get(f"{api.base}/usage/providers")
    assert r.status_code == 200
    rows = {p["provider"]: p for p in r.json()}
    assert rows["good"]["status"] == "ok"
    assert rows["good"]["stale"] is False
    assert rows["bad"]["status"] == "auth_expired"
    assert rows["bad"]["stale"] is True
    assert "no cookie" in rows["bad"]["error"]


def test_current_ok(api):
    r = httpx.get(f"{api.base}/usage/good/current")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["tier"] == "pro"
    assert body["windows"][0]["pct"] == 42


def test_current_auth_expired_stale(api):
    r = httpx.get(f"{api.base}/usage/bad/current")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "auth_expired"
    assert body["stale"] is True


def test_unknown_provider_404(api):
    r = httpx.get(f"{api.base}/usage/nope/current")
    assert r.status_code == 404
    assert r.json() == {"error": "unknown provider"}


def test_history_round_trips_compact_rows(api):
    r = httpx.get(f"{api.base}/usage/good/history")
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1
    assert rows[0]["w5h"] == 42
    assert rows[0]["tier"] == "pro"
    assert rows[0]["t"] > 0


def test_provider_config(api):
    r = httpx.get(f"{api.base}/usage/good/config")
    assert r.status_code == 200
    assert r.json()["label"] == "Good"


def test_root_path_is_501(api):
    r = httpx.get(f"{api.base}/")
    assert r.status_code == 501


def test_cookie_post_round_trip_then_delete(api):
    # POST sets the cookie, persists it (0600), reconfigures, re-polls -> ok
    r = httpx.post(f"{api.base}/usage/good/cookie", content="session=abc123")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    cookie_file = api.tmp / "good.cookie"
    assert cookie_file.read_text() == "session=abc123\n"

    # empty body rejected
    r = httpx.post(f"{api.base}/usage/good/cookie", content="   ")
    assert r.status_code == 400

    # DELETE clears: file gone (the daemon-side contract; this stub's fetch
    # doesn't gate on the cookie, so the re-poll snapshot stays ok)
    r = httpx.delete(f"{api.base}/usage/good/cookie")
    assert r.status_code == 200
    assert not cookie_file.exists()
    secret = api.run(api.runner.store.async_secret_get("good", "cookie"))
    assert secret is None


def test_admin_restart_403_when_control_disabled(api):
    r = httpx.post(f"{api.base}/usage/admin/restart")
    assert r.status_code == 403
    assert r.json() == {"error": "control disabled"}


def test_metrics_only_counts_ok_providers(api):
    api.good_state["pct"] = 55
    snap = api.run(api.runner.poll("good"))
    assert snap["status"] == "ok"

    r = httpx.get(f"{api.base}/metrics")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")
    lines = r.text.splitlines()
    assert "# TYPE usage_provider_status gauge" in lines
    assert 'usage_provider_status{provider="good"} 1' in lines
    # bad provider never reported ok, so it must not appear at all
    assert 'usage_provider_status{provider="bad"}' not in r.text
    assert 'usage_window_pct{provider="good",window="w5h"} 55' in lines


def test_token_auth_post_then_delete(api):
    auth_file = api.tmp / "tok.auth"

    # POST sets the token, persists it (0600), re-polls -> ok
    r = httpx.post(f"{api.base}/usage/tok/auth", content="  tok-abc123  ")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert auth_file.read_text() == "tok-abc123\n"

    # empty payload rejected
    r = httpx.post(f"{api.base}/usage/tok/auth", content="")
    assert r.status_code == 400

    # DELETE clears: file gone
    r = httpx.delete(f"{api.base}/usage/tok/auth")
    assert r.status_code == 200
    assert not auth_file.exists()


def test_cookie_from_firefox_400_without_domain(api):
    r = httpx.post(f"{api.base}/usage/bad/cookie/from-firefox")
    assert r.status_code == 400
    assert "no cookie_from_firefox" in r.json()["error"]


def test_refresh_triggers_manual_poll(api):
    r = httpx.post(f"{api.base}/usage/good/refresh")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

