"""Tests for the `usage` CLI (usage_daemon/cli.py).

Covers both data sources: sqlite read-only mode against a Store fixture, and
live mode against a threaded stub HTTP server. Rendering is tested pure
(no tty), so no color codes leak into assertions.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from usage_daemon.cli import main, render_table
from usage_daemon.sqlite_store import Store

# ---------------------------------------------------------------- helpers


@pytest.fixture()
def store(tmp_path):
    return Store(state_dir=str(tmp_path))


def snap(t, pct, window="w5h"):
    return {"t": t, "tier": "pro", "windows": [{"id": window, "pct": pct}]}


class _Stub(BaseHTTPRequestHandler):
    payload = "[]"
    status = 200
    seen_paths: list[str] = []

    def do_GET(self):
        type(self).seen_paths.append(self.path)
        body = self.payload.encode()
        self.send_response(self.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        return


@pytest.fixture()
def stub_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Stub)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}", _Stub
    server.shutdown()
    thread.join()


LIVE_ROW = [{
    "provider": "claude",
    "status": "ok",
    "stale": False,
    "t": 1_800_000_000_000,
    "tier": "pro",
    "error": None,
    "windows": [{
        "id": "session", "label": "Session", "letter": "Se",
        "pct": 42, "used": 42, "cap": 100, "unit": "%",
        "used_is_remaining": False, "color": "#56B4E9",
        "cycles_remaining": None, "resets_at": None,
        "will_deplete": False, "pct_1h_ago": 10,
    }],
}]


def _run(capsys, *argv):
    rc = main(list(argv))
    captured = capsys.readouterr()
    return rc, captured.out + captured.err


# ---------------------------------------------------------------- sqlite source


def test_sqlite_source_renders_table(capsys, store):
    store.append("demo", snap(1000, 12))
    rc, out = _run(capsys, "--source", "sqlite", "--state-dir", store.dir)
    assert rc == 0
    assert "demo" in out
    assert "ok" in out
    assert "12%" in out


def test_sqlite_source_json_passthrough(capsys, store):
    store.append("demo", snap(1000, 12))
    rc, out = _run(capsys, "--source", "sqlite", "--state-dir", store.dir, "--json")
    assert rc == 0
    rows = json.loads(out)
    assert rows[0]["provider"] == "demo"
    assert rows[0]["status"] == "ok"
    assert rows[0]["windows"][0]["pct"] == 12


def test_sqlite_source_picks_latest_snapshot_per_provider(capsys, store):
    store.append("demo", snap(1000, 12))
    store.append("demo", snap(2000, 34))
    rc, out = _run(capsys, "--source", "sqlite", "--state-dir", store.dir, "--json")
    assert rc == 0
    assert json.loads(out)[0]["windows"][0]["pct"] == 34


def test_sqlite_source_provider_filter(capsys, store):
    store.append("demo", snap(1000, 12))
    store.append("other", snap(1000, 50, window="day"))
    rc, out = _run(capsys, "--source", "sqlite", "--state-dir", store.dir, "-p", "other")
    assert rc == 0
    assert "other" in out


def test_sqlite_source_unknown_provider_exits_1(capsys, store):
    store.append("demo", snap(1000, 12))
    rc, out = _run(capsys, "--source", "sqlite", "--state-dir", store.dir, "-p", "nope")
    assert rc == 1
    assert "nope" in out


def test_sqlite_source_empty_db_still_renders(capsys, store):
    store.state_set("marker", "1")  # materialize usage.sqlite with no snapshots
    rc, out = _run(capsys, "--source", "sqlite", "--state-dir", store.dir)
    assert rc == 0
    assert "0 providers" in out


def test_sqlite_source_missing_db_exits_1(capsys, tmp_path):
    rc, out = _run(capsys, "--source", "sqlite", "--state-dir", str(tmp_path / "absent"))
    assert rc == 1
    assert "no data" in out


def test_sqlite_source_never_touches_secrets_db(capsys, store):
    store.state_set("marker", "1")  # usage.sqlite exists; secrets.sqlite must stay unread
    store.secret_set("demo", "cookie", "super-secret")
    rc, out = _run(capsys, "--source", "sqlite", "--state-dir", store.dir, "--json")
    assert rc == 0
    assert "super-secret" not in out


# ---------------------------------------------------------------- live source


def test_live_source_renders_rows(capsys, stub_server):
    url, handler = stub_server
    handler.payload = json.dumps(LIVE_ROW)
    rc, out = _run(capsys, "--source", "live", "--url", url)
    assert rc == 0
    assert "claude" in out
    assert "Se" in out and "42%" in out
    assert "+32.0/1h" in out  # delta vs pct_1h_ago


def test_live_source_json(capsys, stub_server):
    url, handler = stub_server
    handler.payload = json.dumps(LIVE_ROW)
    rc, out = _run(capsys, "--source", "live", "--url", url, "--json")
    assert rc == 0
    assert json.loads(out)[0]["provider"] == "claude"


def test_live_source_error_status_shows_error_text(capsys, stub_server):
    url, handler = stub_server
    handler.payload = json.dumps([{
        "provider": "grok", "status": "auth_expired", "stale": True,
        "t": 1_800_000_000_000, "error": "Grok token missing or expired",
        "windows": [],
    }])
    rc, out = _run(capsys, "--source", "live", "--url", url)
    assert rc == 0
    assert "auth" in out and "Grok token missing or expired" in out


def test_live_source_http_error_falls_back_to_sqlite(capsys, stub_server, store):
    url, handler = stub_server
    handler.status = 500
    store.append("demo", snap(1000, 12))
    rc, out = _run(capsys, "--source", "auto", "--url", url, "--state-dir", store.dir)
    assert rc == 0
    assert "sqlite" in out  # header shows the fallback source
    assert "demo" in out


def test_live_source_junk_json_falls_back_to_sqlite(capsys, stub_server, store):
    url, handler = stub_server
    handler.payload = '{"not": "a list"}'
    store.append("demo", snap(1000, 12))
    rc, out = _run(capsys, "--source", "auto", "--url", url, "--state-dir", store.dir)
    assert rc == 0
    assert "demo" in out


def test_no_data_anywhere_exits_1(capsys, stub_server, tmp_path):
    url, _ = stub_server
    rc, out = _run(capsys, "--source", "auto", "--url", url,
                   "--state-dir", str(tmp_path / "absent"))
    assert rc == 1
    assert "no data" in out


def test_live_source_requests_providers_route(capsys, stub_server):
    """Regression: the live fetch must hit /usage/providers, not the base URL."""
    url, _ = stub_server
    _Stub.seen_paths.clear()
    _run(capsys, "--source", "live", "--url", url)
    assert _Stub.seen_paths == ["/usage/providers"]


def test_live_url_with_existing_path_is_not_double_appended(capsys, stub_server):
    """Passing the full endpoint URL works too."""
    url, _ = stub_server
    _Stub.seen_paths.clear()
    _run(capsys, "--source", "live", "--url", url + "/usage/providers")
    assert _Stub.seen_paths == ["/usage/providers"]


# ---------------------------------------------------------------- rendering


def test_render_table_is_pure_and_colorless_by_default():
    out = render_table(LIVE_ROW, width=110, color=False)
    assert "\x1b[" not in out
    assert "claude" in out and "42%" in out


def test_render_table_wraps_long_window_lists():
    row = dict(LIVE_ROW[0])
    row["windows"] = [
        {"id": f"w{i}", "label": f"Window{i}", "pct": i, "will_deplete": False}
        for i in range(12)
    ]
    out = render_table([row], width=60, color=False)
    data_lines = [ln for ln in out.splitlines() if "Window" in ln]
    assert len(data_lines) > 1, "long window lists wrap to continuation lines"
    for ln in out.splitlines():
        assert len(ln) <= 61, "wrapped lines respect the width cap"


def test_render_table_marks_depleting_window_with_bang():
    row = {
        "provider": "p", "status": "ok", "stale": False, "t": 1, "error": None,
        "windows": [{"id": "w", "label": "W", "pct": 50, "will_deplete": True}],
    }
    out = render_table([row], width=110, color=False)
    assert "50%!" in out


def test_render_table_balance_meter_without_pct():
    row = {
        "provider": "runpod", "status": "ok", "stale": False, "t": 1, "error": None,
        "windows": [{"id": "balance", "label": "Balance", "pct": None,
                     "used": 12.5, "unit": "USD", "used_is_remaining": True}],
    }
    out = render_table([row], width=110, color=False)
    assert "12.5 USD left" in out


def test_render_table_used_over_cap_fallback():
    row = {
        "provider": "p", "status": "ok", "stale": False, "t": 1, "error": None,
        "windows": [{"id": "w", "label": "W", "pct": None, "used": 3, "cap": 10, "unit": "req"}],
    }
    out = render_table([row], width=110, color=False)
    assert "3/10 req" in out
