"""Entry point for `python -m usage_daemon` and the `usage-daemon-v3` script.

Port of src/index.js: IPv4-first, logging configured, compiled-in providers
registered, runner started, HTTP surface bound to 0.0.0.0:<port> (LAN-reachable
— no per-request auth; keep it behind the LAN/Tailscale boundary). EADDRINUSE
is retried ~6s because the admin restart route may respawn us while the outgoing
process still holds the socket; exhausting retries means someone else owns the
port and we refuse to start rather than spin.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import sys
import time

from . import __version__
from .config import expand_home, load_config
from .httputil import force_ipv4
from .log import install_process_handlers, log, log_file
from .registry import registry
from .runner import Runner, now_ms

LISTEN_RETRY_S = 0.5
LISTEN_RETRIES = 12  # ~6s of grace for the outgoing process to exit


def _under_systemd_supervision() -> bool:
    """Best-effort detection of restart-capable systemd ownership.

    `INVOCATION_ID` is too broad on a desktop session: GUI-launched processes can
    inherit it while living under `session.slice`, where no dedicated service unit
    will restart them. Treat only `app.slice`/`system.slice` placements as
    supervised for admin restart/stop semantics.
    """
    try:
        for line in open("/proc/self/cgroup", "r", encoding="utf-8"):
            parts = line.strip().split(":", 2)
            if len(parts) != 3:
                continue
            path = parts[2]
            if "/app.slice/" in path or "/system.slice/" in path:
                return True
    except OSError:
        pass
    return False


def _register_compiled_in() -> None:
    from .providers.aion import create as create_aion
    from .providers.abacus import create as create_abacus
    from .providers.claude import create_provider as create_claude
    from .providers.cloudflare import create as create_cloudflare
    from .providers.cohere import create_provider as create_cohere
    from .providers.consensus import create as create_consensus
    from .providers.context7 import create as create_context7
    from .providers.deepgram import create as create_deepgram
    from .providers.elevenlabs import create as create_elevenlabs
    from .providers.firecrawl import create as create_firecrawl
    from .providers.github import create as create_github
    from .providers.grok import create as create_grok
    from .providers.groq import create as create_groq
    from .providers.hyper import create_provider as create_hyper
    from .providers.llm7 import create as create_llm7
    from .providers.mistral import create as create_mistral
    from .providers.ollama import create_provider as create_ollama
    from .providers.opencode_go import create as create_opencode_go
    from .providers.openrouter import create as create_openrouter
    from .providers.runpod import create as create_runpod
    from .providers.serpapi import create as create_serpapi
    from .providers.tavily import create as create_tavily
    from .providers.voyage import create as create_voyage

    registry.register("aion", create_aion)
    registry.register("ollama", create_ollama)
    registry.register("claude", create_claude)
    registry.register("hyper", create_hyper)
    registry.register("cohere", create_cohere)
    registry.register("abacus", create_abacus)
    registry.register("llm7", create_llm7)
    registry.register("github", create_github)
    registry.register("runpod", create_runpod)
    registry.register("mistral", create_mistral)
    registry.register("grok", create_grok)
    registry.register("opencode-go", create_opencode_go)
    registry.register("openrouter", create_openrouter)
    registry.register("cloudflare", create_cloudflare)
    registry.register("deepgram", create_deepgram)
    registry.register("groq", create_groq)
    registry.register("firecrawl", create_firecrawl)
    registry.register("serpapi", create_serpapi)
    registry.register("tavily", create_tavily)
    registry.register("context7", create_context7)
    registry.register("consensus", create_consensus)
    registry.register("elevenlabs", create_elevenlabs)
    registry.register("voyage", create_voyage)


def _build_runner(cfg: dict) -> Runner:
    from .sqlite_store import Store

    runner = Runner(store=Store())
    for name, pcfg in (cfg.get("providers") or {}).items():
        if pcfg.get("enabled") is False:
            continue
        if not registry.has(name):
            log.warn("config names unknown provider, skipping", {"provider": name})
            continue
        provider = registry.create(name)
        if provider.get("configure"):
            provider["configure"](pcfg)
        auth_file = (
            pcfg.get("api_token_file")
            or pcfg.get("api_key_file")
            or pcfg.get("token_file")
            or pcfg.get("credentials_path")
        )
        runner.add(
            provider,
            {
                "cookieFile": expand_home(pcfg.get("cookie_file")),
                "authFile": expand_home(auth_file),
                "cookieFromFirefox": pcfg.get("cookie_from_firefox"),
            },
        )
        log.info("provider enabled", {
            "provider": name,
            "interval_s": provider.get("interval_seconds", (lambda: 300))(),
            "cookie_from_firefox": pcfg.get("cookie_from_firefox"),
        })
    return runner


def _listen(server_factory, port: int):
    """Bind with EADDRINUSE retries; fatal-exit if someone else owns the port."""
    for attempt in range(1, LISTEN_RETRIES + 1):
        try:
            server = server_factory()
            log.info("listening", {"url": f"http://0.0.0.0:{port}", "pid": os.getpid()})
            return server
        except OSError as err:
            if getattr(err, "errno", None) != 98:  # EADDRINUSE
                raise
            log.warn("port busy, retrying listen", {"port": port, "attempt": attempt, "of": LISTEN_RETRIES})
            time.sleep(LISTEN_RETRY_S)
    log.fatal("port still in use after retries — another daemon owns it, refusing to start", {
        "port": port, "hint": f"ss -tlnp | grep {port}",
    })
    sys.exit(1)


def main(argv: list[str] | None = None) -> int:
    force_ipv4()  # must be first — before any provider fetch (lab has no IPv6)

    parser = argparse.ArgumentParser(
        prog="usage-daemon-v3",
        description="Poll provider quotas and serve /usage/* over HTTP.",
    )
    parser.add_argument("-c", "--config", default=None, help="Path to config.toml")
    parser.add_argument("--port", type=int, default=None, help="Override HTTP port")
    args = parser.parse_args(argv)

    started_at = now_ms()
    shutdown = {"fn": lambda sig=None: None}
    install_process_handlers(on_shutdown=lambda sig: shutdown["fn"](sig))

    async def amain() -> None:
        from . import http as http_mod
        from .log import configure as configure_log

        cfg = load_config(args.config)
        configure_log({**(cfg.get("logging") or {}), "file": expand_home((cfg.get("logging") or {}).get("file"))})
        if args.port:
            cfg["port"] = args.port
        under_systemd = _under_systemd_supervision()
        log.info("daemon starting", {
            "version": __version__,
            "pid": os.getpid(),
            "python": sys.version.split()[0],
            "cwd": os.getcwd(),
            "under_systemd": under_systemd,
            "log_file": log_file(),
        })

        _register_compiled_in()
        runner = _build_runner(cfg)
        runner.start()

        port = int(cfg.get("port") or 8787)
        meta = {
            "version": __version__,
            "startedAt": started_at,
            "underSystemd": under_systemd,
            "logFile": log_file(),
            "control": cfg.get("control") or {},
        }
        loop = asyncio.get_running_loop()
        server = _listen(lambda: http_mod.create_server(runner, meta, loop=loop, port=port), port)
        stop_event = asyncio.Event()
        import threading

        threading.Thread(target=server.serve_forever, daemon=True).start()

        def _stop_runner_and_exit():
            runner.stop()
            stop_event.set()

        def _close_server():
            try:
                server.shutdown()  # stop serve_forever; joins its thread
            except Exception:
                pass
            try:
                server.server_close()
            except Exception:
                pass

        def _finish_exit():
            try:
                loop.call_soon_threadsafe(_stop_runner_and_exit)
            except Exception as err:
                # Signal path must never wedge the daemon: if the loop is gone
                # the graceful handoff is impossible — exit hard.
                log.fatal("graceful teardown failed, exiting hard", {"err": err})
                os._exit(0)

        def _respawn_detached():
            logfile = meta.get("logFile") or log_file()
            cmd = [sys.executable, "-m", "usage_daemon"]
            if args.config:
                cmd.extend(["--config", args.config])
            if args.port is not None:
                cmd.extend(["--port", str(args.port)])
            with open(logfile, "a") as f:
                child = subprocess.Popen(
                    cmd,
                    cwd=os.getcwd(),
                    stdout=f,
                    stderr=f,
                    env={**os.environ, "USAGE_LOG_STDERR": "0"},
                    start_new_session=True,
                )
            return child.pid, cmd, logfile

        def _admin_action(action: str):
            under_systemd = meta.get("underSystemd", False)
            if action == "restart":
                log.warn("restarting on admin request", {
                    "via": "systemd Restart=always" if under_systemd else "self-respawn",
                })
                _close_server()
                if not under_systemd:
                    try:
                        pid, cmd, logfile = _respawn_detached()
                        log.warn("respawned replacement daemon", {
                            "child_pid": pid,
                            "cmd": cmd,
                            "log_file": logfile,
                        })
                    except Exception as err:
                        log.fatal("respawn failed — daemon is going down with no replacement", {"err": err})
                _finish_exit()
                return
            if action == "stop":
                log.warn(
                    "stopping on admin request — supervised, systemd will restart it in ~5s"
                    if under_systemd
                    else "stopping on admin request — daemon will stay down until restarted",
                    {"action": action},
                )
                _close_server()
                _finish_exit()
                return
            log.error("unknown admin action", {"action": action})

        def _teardown(sig=None):
            log.info("teardown", {"signal": sig})
            _close_server()
            _finish_exit()

        meta["admin_action"] = _admin_action
        shutdown["fn"] = _teardown
        await stop_event.wait()  # run until a signal tears us down

    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())