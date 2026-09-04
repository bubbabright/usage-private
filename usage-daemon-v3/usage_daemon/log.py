"""Structured, durable logging (port of src/log.js).

Every write is synchronous and goes to a self-rotating file AND stderr (under
systemd that is journald). Sync-only is what survives an atexit/signal handler,
so crash evidence is never buffered away.
"""

import atexit
import os
import sys
import time
from datetime import datetime, timedelta

LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40, "fatal": 50}


def _default_log_file() -> str:
    xdg = os.environ.get("XDG_STATE_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "state"
    )
    base = os.environ.get("USAGE_STATE_DIR") or os.path.join(xdg, "usage-daemon")
    return os.path.join(base, "daemon.log")


_state = {
    "file": os.environ.get("USAGE_LOG_FILE") or _default_log_file(),
    "level": LEVELS.get(os.environ.get("USAGE_LOG_LEVEL", "") or "", 20),
    "stderr": os.environ.get("USAGE_LOG_STDERR") != "0",
    "max_bytes": int(os.environ.get("USAGE_LOG_MAX_BYTES") or (5 * 1024 * 1024)),
    "keep": int(os.environ.get("USAGE_LOG_KEEP") or 3),
    "file_broken": False,
}


def configure(opts: dict | None = None) -> None:
    """Apply config.toml's [logging] table; env vars still win."""
    opts = opts or {}
    if opts.get("file") and not os.environ.get("USAGE_LOG_FILE"):
        _state["file"] = opts["file"]
    if opts.get("level") and os.environ.get("USAGE_LOG_LEVEL") is None:
        lvl = LEVELS.get(str(opts["level"]).lower())
        if lvl is not None:
            _state["level"] = lvl
    if opts.get("stderr") is False and os.environ.get("USAGE_LOG_STDERR") is None:
        _state["stderr"] = False
    if opts.get("max_bytes") and not os.environ.get("USAGE_LOG_MAX_BYTES"):
        _state["max_bytes"] = int(opts["max_bytes"])
    if opts.get("keep") and not os.environ.get("USAGE_LOG_KEEP"):
        _state["keep"] = int(opts["keep"])
    _state["file_broken"] = False


def log_file() -> str:
    return _state["file"]


def _rotate_if_needed() -> None:
    try:
        size = os.path.getsize(_state["file"])
    except OSError:
        return
    if size < _state["max_bytes"]:
        return
    try:
        try:
            os.unlink(f"{_state['file']}.{_state['keep']}")
        except OSError:
            pass
        for i in range(_state["keep"] - 1, 0, -1):
            try:
                os.replace(f"{_state['file']}.{i}", f"{_state['file']}.{i + 1}")
            except OSError:
                pass
        os.replace(_state["file"], f"{_state['file']}.1")
    except OSError:
        pass


def _stamp(d: datetime | None = None) -> str:
    d = d or datetime.now().astimezone()
    off = d.utcoffset() or timedelta(0)
    total = int(off.total_seconds())
    sign = "+" if total >= 0 else "-"
    total = abs(total)
    oh, om = total // 3600, (total % 3600) // 60
    return (
        f"{d.year:04d}-{d.month:02d}-{d.day:02d}T"
        f"{d.hour:02d}:{d.minute:02d}:{d.second:02d}.{d.microsecond // 1000:03d}"
        f"{sign}{oh:02d}:{om:02d}"
    )


def _fields(obj: dict | None) -> str:
    if not obj:
        return ""
    import json as _json

    parts: list[str] = []
    for k, v in obj.items():
        if v is None:
            continue
        if isinstance(v, Exception):
            s = str(v)
        elif isinstance(v, (dict, list, tuple)):
            try:
                s = _json.dumps(v)
            except Exception:
                s = str(v)
        else:
            s = str(v)
        s = s.replace("\n", "\\n")
        if any(ch in s for ch in (" ", '"')):
            escaped = s.replace('"', '\\"')
            parts.append(f'{k}="{escaped}"')
        else:
            parts.append(f"{k}={s}")
    return (" " + " ".join(parts)) if parts else ""


def _write(level: str, msg: str, ctx: dict | None = None) -> None:
    if LEVELS.get(level, 20) < _state["level"]:
        return
    line = f"{_stamp()} {level.upper():<5} usage-daemon: {msg}{_fields(ctx)}\n"
    if _state["stderr"]:
        try:
            sys.stderr.write(line)
            sys.stderr.flush()
        except Exception:
            pass
    if _state["file_broken"]:
        return
    try:
        _rotate_if_needed()
        with open(_state["file"], "a", encoding="utf-8") as f:
            f.write(line)
    except Exception as err:
        try:
            os.makedirs(os.path.dirname(_state["file"]), exist_ok=True)
            with open(_state["file"], "a", encoding="utf-8") as f:
                f.write(line)
        except Exception:
            _state["file_broken"] = True
            try:
                sys.stderr.write(
                    f"{_stamp()} ERROR usage-daemon: log file unwritable "
                    f"({_state['file']}): {err} — stderr only from here\n"
                )
                sys.stderr.flush()
            except Exception:
                pass


class _Log:
    def debug(self, msg: str, ctx: dict | None = None) -> None:
        _write("debug", msg, ctx)

    def info(self, msg: str, ctx: dict | None = None) -> None:
        _write("info", msg, ctx)

    def warn(self, msg: str, ctx: dict | None = None) -> None:
        _write("warn", msg, ctx)

    def error(self, msg: str, ctx: dict | None = None) -> None:
        _write("error", msg, ctx)

    def fatal(self, msg: str, ctx: dict | None = None) -> None:
        _write("fatal", msg, ctx)


log = _Log()

_START_TIME = time.time()


def install_process_handlers(on_shutdown=None) -> None:
    """Install signal + atexit handlers. on_shutdown(sig) runs on SIGTERM/INT/HUP/QUIT."""
    import signal
    import sys as _sys

    exiting = {"flag": False}

    def _sig(signum, _frame):
        if exiting["flag"]:
            return
        exiting["flag"] = True
        try:
            name = signal.Signals(signum).name
        except Exception:
            name = str(signum)
        log.warn("received signal, shutting down", {"signal": name})
        if on_shutdown:
            on_shutdown(name)
        else:
            _sys.exit(0)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGQUIT):
        try:
            signal.signal(sig, _sig)
        except (ValueError, OSError):
            pass  # not the main thread / unsupported signal

    def _atexit() -> None:
        try:
            log.fatal("process exiting", {"uptime_s": round(time.time() - _START_TIME)})
        except Exception:
            pass

    atexit.register(_atexit)