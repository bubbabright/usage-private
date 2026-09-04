"""HTTP surface (port of src/http.js).

Binds 0.0.0.0 — reachable from the LAN, no per-request auth; keep it behind the
LAN/Tailscale boundary. Serves /usage/* and /metrics with no-store caching.

Routes (per the JS router; icon routes intentionally NOT ported — see plan §6):
  GET   /usage/health
  POST  /usage/admin/:action
  GET   /usage/providers
  GET   /usage/headline
  GET   /usage/:provider/config | current | history
  POST  /usage/:provider/refresh | cookie | cookie/from-firefox | auth
  DELETE /usage/:provider/cookie | auth
  GET   /metrics
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

from .headline import compute_headline
from .log import log, log_file as default_log_file

MAX_BODY = 64 * 1024


def create_server(runner, meta: dict | None = None, *, loop, port: int = 8787):
    """Build a ThreadingHTTPServer wired to the runner + the main event loop."""
    meta = meta or {}
    meta["port"] = port

    def factory(*a, **k):
        return _Handler(runner, meta, loop, *a, **k)

    return ThreadingHTTPServer(("0.0.0.0", port), factory)


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, runner, meta, loop, *args, **kwargs):
        self._runner = runner
        self._meta = meta
        self._loop = loop
        self._body = b""
        super().__init__(*args, **kwargs)

    def log_message(self, fmt, *args):  # silence default stderr request chatter
        return

    def _sync(self, coro, timeout=120.0):
        fut = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return fut.result(timeout=timeout)

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status, message):
        self._send_json({"error": message}, status=status)

    def _read_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n > MAX_BODY:
            raise ValueError("request body too large")
        raw = self.rfile.read(n) if n else b""
        ctype = self.headers.get("Content-Type", "")
        text = raw.decode("utf-8", "replace").strip()
        if "json" in ctype:
            try:
                return json.loads(text) if text else {}
            except Exception:
                return {}
        return text

    def do_GET(self):
        self._dispatch()

    def do_POST(self):
        self._dispatch()

    def do_DELETE(self):
        self._dispatch()

    def _dispatch(self):
        method = self.command
        try:
            split = urlsplit(self.path)
            segments = [unquote(s) for s in split.path.split("/") if s]
            self._route(method, segments)
        except BrokenPipeError:
            return
        except Exception as err:
            log.error("request failed", {"method": method, "path": self.path, "err": err})
            try:
                self._send_error(500, str(err) or "internal error")
            except Exception:
                pass

    def _route(self, method, seg):
        runner = self._runner
        if not seg:
            self._send_json({"error": "not implemented (dashboard/report not ported)"}, 501)
            return
        if seg[0] == "usage":
            self._route_usage(method, seg[1:])
            return
        if seg[0] == "metrics" and method == "GET":
            self._metrics()
            return
        self._send_error(404, "not found")

    def _metrics(self):
        runner = self._runner
        lines = [
            "# HELP usage_provider_status Provider status (1=ok, 0=not ok)",
            "# TYPE usage_provider_status gauge",
            "# HELP usage_window_pct Window usage percentage",
            "# TYPE usage_window_pct gauge",
        ]
        for name, snap in runner.current.items():
            if not snap or snap.get("status") != "ok":
                continue
            ok = 1 if (snap.get("status") == "ok" and not snap.get("stale")) else 0
            lines.append(f'usage_provider_status{{provider="{name}"}} {ok}')
            for w in snap.get("windows") or []:
                p = w.get("pct")
                if isinstance(p, (int, float)) and not isinstance(p, bool):
                    lines.append(f'usage_window_pct{{provider="{name}",window="{w["id"]}"}} {p}')
        body = ("\n".join(lines) + "\n").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _route_usage(self, method, seg):
        runner = self._runner
        meta = self._meta

        if not seg:
            self._send_json({"error": "not implemented"}, 501)
            return
        head = seg[0]

        if head == "health" and method == "GET":
            rows = runner.list()
            ok = sum(1 for p in rows if p["status"] == "ok" and not p["stale"])
            stale = sum(1 for p in rows if p["status"] == "ok" and p["stale"])
            down = sum(1 for p in rows if p["status"] != "ok")
            control_enabled = meta.get("control", {}).get("allow_control") is True
            started = meta.get("startedAt", 0)
            self._send_json({
                "version": meta.get("version", "unknown"),
                "started_at": started,
                "uptime_s": round((time.time() * 1000 - started) / 1000),
                "under_systemd": meta.get("underSystemd", False),
                "control": {
                    "enabled": control_enabled,
                    "restart": control_enabled,
                    "stop": control_enabled,
                    "start": False,
                },
                "providers": {"total": len(rows), "ok": ok, "stale": stale, "down": down},
            })
            return

        if head == "admin" and method == "POST":
            self._admin(seg[1:])
            return

        if head == "providers" and method == "GET":
            self._send_json(runner.list())
            return

        if head == "headline" and method == "GET":
            providers_data = []
            for name in runner.providers:
                e = runner.providers[name]
                providers_data.append({
                    "name": name,
                    "label": (e["provider"].get("config") or (lambda: {}))().get("label"),
                    "current": runner.get_current(name),
                    "history": self._sync(runner.get_history(name)),
                })
            self._send_json(compute_headline(providers_data))
            return

        if head not in runner.providers:
            self._send_error(404, "unknown provider")
            return
        name = head
        rest = seg[1:]

        if rest and rest[0] == "cookie" and len(rest) > 1 and rest[1] == "from-firefox" and method == "POST":
            try:
                self._send_json(self._sync(runner.refresh_cookie_from_firefox(name)))
            except Exception as e2:
                self._send_error(400, str(e2))
            return

        if rest and rest[0] == "cookie" and method == "POST":
            body = self._read_body()
            cookie = body if isinstance(body, str) else (body.get("cookie", "") if isinstance(body, dict) else "")
            cookie = str(cookie).strip()
            if not cookie:
                self._send_error(400, "empty cookie")
                return
            try:
                self._send_json(self._sync(runner.set_cookie(name, cookie)))
            except Exception as e2:
                self._send_error(500, str(e2))
            return

        if rest and rest[0] == "cookie" and method == "DELETE":
            try:
                self._send_json(self._sync(runner.clear_cookie(name)))
            except Exception as e2:
                self._send_error(500, str(e2))
            return

        if rest and rest[0] == "auth" and method == "POST":
            body = self._read_body()
            payload = body if isinstance(body, str) else (body.get("payload", "") if isinstance(body, dict) else "")
            payload = str(payload).strip()
            if not payload:
                self._send_error(400, "empty payload")
                return
            try:
                self._send_json(self._sync(runner.set_auth_payload(name, payload)))
            except Exception as e2:
                self._send_error(500, str(e2))
            return

        if rest and rest[0] == "auth" and method == "DELETE":
            try:
                self._send_json(self._sync(runner.clear_auth(name)))
            except Exception as e2:
                self._send_error(500, str(e2))
            return

        if rest and rest[0] == "config" and method == "GET":
            cfg = (runner.providers[name]["provider"].get("config") or (lambda: {}))()
            self._send_json(cfg or {"error": "no config"})
            return

        if rest and rest[0] == "current" and method == "GET":
            snap = runner.get_current(name)
            if snap is None:
                self._send_error(404, "no snapshot yet")
                return
            self._send_json(snap)
            return

        if rest and rest[0] == "history" and method == "GET":
            self._send_json(self._sync(runner.get_history(name)))
            return

        if rest and rest[0] == "refresh" and method == "POST":
            try:
                self._send_json(self._sync(runner.poll(name, manual=True)))
            except Exception as e2:
                self._send_error(500, str(e2))
            return

        self._send_error(404, "not found")

    def _admin(self, seg):
        runner = self._runner
        meta = self._meta
        if not seg:
            self._send_error(404, "unknown action")
            return
        action = seg[0]
        control_enabled = meta.get("control", {}).get("allow_control") is True
        log.warn("admin action requested", {
            "action": action, "ua": self.headers.get("User-Agent"),
            "control_enabled": control_enabled,
        })
        if not control_enabled:
            self._send_error(403, "control disabled")
            return
        if action == "start":
            self._send_error(400, "start unsupported over HTTP")
            return
        if action in ("restart", "stop"):
            under = meta.get("underSystemd", False)
            self._send_json({"ok": True, "action": action, "via": "systemd" if under else "respawn"})

            def _later():
                time.sleep(0.15)
                runner.stop()
                if action == "restart" and not under:
                    self._respawn()
                sys.exit(0)

            threading.Thread(target=_later, daemon=True).start()
            return
        self._send_error(404, f"unknown action: {action}")

    def _respawn(self):
        logfile = self._meta.get("logFile") or default_log_file()
        cmd = [sys.executable, "-m", "usage_daemon"]
        try:
            with open(logfile, "a") as f:
                env = {"USAGE_LOG_STDERR": "0"}
                subprocess.Popen(cmd, stdout=f, stderr=f, env=env, start_new_session=True)
        except Exception as err:
            log.fatal("respawn failed — daemon is going down with no replacement", {"err": err})