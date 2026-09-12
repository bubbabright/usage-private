"""Presentation layer: `usage` — one-shot CLI for the daemon's stats.

Two data sources, never a poller:

  live    GET http://127.0.0.1:<port>/usage/providers — the running daemon's
          in-memory rows (labels, used/cap, resets_at, pct_1h_ago).
  sqlite  read-only peek at usage.sqlite's snapshots table — works while the
          daemon is down (WAL allows concurrent readers). Latest snapshots are
          stored with full window metadata; 1h deltas are recomputed client-side
          from compact history rows in the same DB.

`auto` tries live first and falls back to sqlite. Secrets are NEVER read.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
import tomllib
from datetime import datetime
from pathlib import Path

from .history_utils import find_activity_base
from .sqlite_store import default_state_dir, history_row

LIVE_TIMEOUT_S = 2.0
ONE_HOUR_MS = 60 * 60 * 1000

_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_RESET = "\x1b[0m"

STATUS_CELL = {
    "ok": ("ok", 32),
    "auth_expired": ("auth", 31),
    "rate_limited": ("rate", 33),
    "error": ("error", 31),
    "pending": ("pending", 2),
}


def now_ms() -> int:
    return int(time.time() * 1000)


def _paint(text: str, code: int | None, on: bool) -> str:
    if not on or code is None:
        return text
    return f"\x1b[{code}m{text}{_RESET}"


def _vlen(s: str) -> int:
    return len(_ANSI.sub("", s))


def _config_port() -> int | None:
    """Resolve the daemon's HTTP port from config.toml (no log side effects)."""
    from .config import _config_path

    for path in (_config_path(), Path.cwd() / "config.toml"):
        try:
            parsed = tomllib.loads(path.read_bytes().decode("utf-8"))
            port = parsed.get("port")
            if port:
                return int(port)
        except Exception:
            continue
    return None


def _fetch_live_rows(base_url: str) -> list[dict] | None:
    """GET <base>/usage/providers. Loopback targets bypass proxy env vars."""
    import httpx
    from urllib.parse import urlsplit

    url = base_url.rstrip("/")
    if not url.endswith("/usage/providers"):
        url += "/usage/providers"
    host = (urlsplit(base_url).hostname or "").lower()
    trust_env = host not in ("127.0.0.1", "localhost", "::1")
    try:
        res = httpx.get(url, timeout=LIVE_TIMEOUT_S, trust_env=trust_env,
                        headers={"Accept": "application/json"})
    except Exception:
        return None
    if res.status_code != 200:
        return None
    try:
        rows = res.json()
    except Exception:
        return None
    return rows if isinstance(rows, list) else None

def _sqlite_rows(state_dir: str) -> list[dict]:
    """Latest snapshot per provider, shaped like runner.list() rows.

    Read-only (mode=ro) so a CLI run can never create or migrate anything.
    Supports both new full-snapshot rows and older compact-history rows already
    on disk.
    """
    import sqlite3

    path = os.path.join(state_dir, "usage.sqlite")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        latest = conn.execute(
            """
            SELECT s.provider AS provider, s.t AS t, s.tier AS tier, s.row AS row
            FROM snapshots s
            JOIN (SELECT provider, MAX(t) AS mt FROM snapshots GROUP BY provider) m
              ON s.provider = m.provider AND s.t = m.mt
            ORDER BY s.provider
            """
        ).fetchall()
        cutoff = now_ms() - 6 * ONE_HOUR_MS  # lookback for 1h deltas + burn slope
        rows = []
        for r in latest:
            try:
                cur = json.loads(r["row"])
            except Exception:
                continue
            history = []
            for h in conn.execute(
                "SELECT row FROM snapshots WHERE provider=? AND t>=? ORDER BY t",
                (r["provider"], cutoff),
            ):
                if not h["row"]:
                    continue
                try:
                    obj = json.loads(h["row"])
                except Exception:
                    continue
                history.append(history_row(obj) if isinstance(obj, dict) and isinstance(obj.get("windows"), list) else obj)

            if isinstance(cur, dict) and isinstance(cur.get("windows"), list):
                windows = []
                for w in cur.get("windows", []):
                    pct = w.get("pct")
                    base = find_activity_base(history, w["id"], cur["t"], ONE_HOUR_MS) if isinstance(pct, (int, float)) else None
                    pct_1h_ago = base["value"] if base and base["value"] <= pct else None
                    clean = {k: v for k, v in w.items() if k != "will_deplete"}
                    windows.append({**clean, "pct_1h_ago": pct_1h_ago})
                rows.append({
                    **cur,
                    "provider": cur.get("provider") or r["provider"],
                    "status": cur.get("status") or "ok",
                    "stale": bool(cur.get("stale", False)),
                    "t": cur.get("t") or r["t"],
                    "tier": cur.get("tier", r["tier"]),
                    "error": cur.get("error"),
                    "windows": windows,
                })
                continue

            windows = []
            for wid, pct in cur.items():
                if wid in ("t", "tier") or not isinstance(pct, (int, float)):
                    continue
                base = find_activity_base(history, wid, cur["t"], ONE_HOUR_MS)
                pct_1h_ago = base["value"] if base and base["value"] <= pct else None
                windows.append({
                    "id": wid,
                    "label": wid,
                    "letter": None,
                    "pct": pct,
                    "used": None,
                    "cap": None,
                    "unit": None,
                    "used_is_remaining": False,
                    "color": None,
                    "cycles_remaining": None,
                    "resets_at": None,
                    "pct_1h_ago": pct_1h_ago,
                })
            rows.append({
                "provider": r["provider"],
                "status": "ok",  # snapshots only exist for successful polls
                "stale": False,
                "t": cur["t"],
                "tier": r["tier"],
                "error": None,
                "windows": windows,
            })
        return rows
    finally:
        conn.close()


# --- rendering ------------------------------------------------------------

def _age(ms: int) -> str:
    s = max(0, int(ms / 1000))
    if s < 90:
        return f"{s}s"
    m = s // 60
    if m < 90:
        return f"{m}m"
    h = m // 60
    if h < 36:
        return f"{h}h"
    return f"{h // 24}d"


def _resets_short(iso) -> str | None:
    """resets_at ISO → '16:00' today, 'Sep 9 16:00' otherwise; None if unparseable."""
    if not iso or isinstance(iso, (int, float)):
        return None
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except Exception:
        return None
    local = dt.astimezone()
    if local.date() == datetime.now().astimezone().date():
        return local.strftime("%H:%M")
    return f"{local.strftime('%b')} {local.day} {local.strftime('%H:%M')}"


def _fmt_num(v) -> str:
    """Compact display: max 2 decimals, trailing zeros trimmed (71.4053→71.41, 12→12)."""
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return s or "0"


def _value_text(w: dict) -> str:
    pct, used, cap = w.get("pct"), w.get("used"), w.get("cap")
    unit = w.get("unit") or ""
    if isinstance(pct, (int, float)):
        return f"{_fmt_num(pct)}%"
    if isinstance(used, (int, float)) and isinstance(cap, (int, float)):
        return f"{_fmt_num(used)}/{_fmt_num(cap)}{(' ' + unit) if unit else ''}"
    if isinstance(used, (int, float)):
        tail = " left" if w.get("used_is_remaining") else ""
        return f"{_fmt_num(used)}{(' ' + unit) if unit else ''}{tail}"
    return w.get("label") or w.get("id") or "?"


def _pct_color(pct) -> int | None:
    if not isinstance(pct, (int, float)):
        return None
    if pct >= 85:
        return 31
    if pct >= 60:
        return 33
    return 32


def _window_segments(w: dict, color: bool) -> list[str]:
    """One window → short colored tokens (name, bar, value, reset, delta)."""
    name = w.get("letter") or w.get("label") or w.get("id") or "?"
    pct = w.get("pct")
    code = _pct_color(pct)
    out = [_paint(name, 1 if color else None, color)]
    if isinstance(pct, (int, float)):
        filled = max(0, min(8, round(pct / 100 * 8)))
        bar = "█" * filled + "·" * (8 - filled)
        out.append(_paint(bar, code, color))
    out.append(_paint(_value_text(w), code, color))
    resets = _resets_short(w.get("resets_at"))
    if resets:
        out.append(_paint(f"↻{resets}", 36, color))
    ago, pctv = w.get("pct_1h_ago"), w.get("pct")
    if isinstance(ago, (int, float)) and isinstance(pctv, (int, float)) and abs(pctv - ago) >= 0.5:
        out.append(_paint(f"{pctv - ago:+.1f}/1h", 2, color))
    return out


def _wrap(segments: list[str], avail: int) -> list[str]:
    """Greedy two-space wrap of colored tokens to `avail` visible columns."""
    lines: list[str] = []
    cur = ""
    for seg in segments:
        cand = seg if not cur else f"{cur}  {seg}"
        if _vlen(cand) <= avail or not cur:
            cur = cand
        else:
            lines.append(cur)
            cur = seg
    if cur:
        lines.append(cur)
    return lines or [""]


def render_table(rows: list[dict], *, width: int | None = None, color: bool = False) -> str:
    """Pure rows → table string (no I/O)."""
    if width is None:
        width = shutil.get_terminal_size((110, 24)).columns
    now = now_ms()

    prov_cells = [r.get("provider") or "?" for r in rows]
    stat_cells = [STATUS_CELL.get(r.get("status") or "pending", ("?", None)) for r in rows]
    age_cells = [_age(now - r["t"]) if r.get("t") else "-" for r in rows]

    w_p = max([len("provider"), *map(len, prov_cells)])
    w_s = max([len("status"), *(len(c[0]) for c in stat_cells)])
    w_a = max([len("age"), *map(len, age_cells)])
    prefix_w = w_p + w_s + w_a + 3  # three single spaces between prefix cells
    avail = max(20, width - prefix_w - 2)

    def line(cells) -> str:
        text = ""
        for cell, w in zip(cells, (w_p, w_s, w_a)):
            text += _paint(cell[0].ljust(w), cell[1], color) + " "
        return text

    out: list[str] = []
    out.append(
        _paint("provider".ljust(w_p) + " " + "status".ljust(w_s) + " " + "age", 1, color)
        + "  windows"
    )
    for i, r in enumerate(rows):
        prefix = line([
            (prov_cells[i], None),
            (stat_cells[i][0], stat_cells[i][1]),
            (age_cells[i], 2 if color else None),
        ])
        segs: list[str] = []
        for w in r.get("windows") or []:
            segs.extend(_window_segments(w, color))
            segs.append(_paint("│", 2, color) if color else "│")
        if segs:
            segs.pop()  # drop trailing separator
        if r.get("error"):
            segs.append(_paint(f"⚠ {r['error']}", 31, color))
        wrapped = _wrap(segs, avail)
        out.append(prefix.rstrip() + "  " + wrapped[0])
        out.extend(" " * (prefix_w + 2) + extra for extra in wrapped[1:])

    ok = sum(1 for r in rows if r.get("status") == "ok" and not r.get("stale"))
    out.append("")
    out.append(_paint(f"{len(rows)} providers: {ok} ok, {len(rows) - ok} not ok", 2, color))
    return "\n".join(out)


# --- entry point ----------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="usage",
        description=(
            "Show LLM/API provider quota stats from usage-daemon"
            " (live daemon or its sqlite history)."
        ),
    )
    parser.add_argument("--source", choices=("auto", "live", "sqlite"), default="auto",
                        help="data source: live daemon, sqlite history, or auto (default)")
    parser.add_argument("--url", default=None,
                        help="live daemon base URL (default http://127.0.0.1:<port>)")
    parser.add_argument("--port", type=int, default=None,
                        help="live daemon port (default: config.toml port or 8787)")
    parser.add_argument("-p", "--provider", default=None, help="only show this provider")
    parser.add_argument("--json", action="store_true",
                        help="print raw row JSON instead of a table")
    parser.add_argument("--state-dir", default=None,
                        help="state dir for sqlite mode (default: USAGE_STATE_DIR or ~/.local/state/usage-daemon)")
    parser.add_argument("--width", type=int, default=None,
                        help="table width (default: terminal width)")
    parser.add_argument("--no-color", action="store_true",
                        help="disable ANSI colors (also honors NO_COLOR / non-tty)")
    args = parser.parse_args(argv)

    color = sys.stdout.isatty() and not args.no_color and not os.environ.get("NO_COLOR")

    port = args.port or _config_port() or 8787
    url = args.url or f"http://127.0.0.1:{port}"

    rows: list[dict] | None = None
    source = None
    if args.source in ("auto", "live"):
        rows = _fetch_live_rows(url)
        source = "live" if rows is not None else None
    if rows is None and args.source in ("auto", "sqlite"):
        state_dir = args.state_dir or default_state_dir()
        try:
            rows = _sqlite_rows(state_dir)
            source = "sqlite"
        except Exception:
            rows = None

    if rows is None:
        print(f"usage: no data — daemon not reachable at {url} and no sqlite history found",
              file=sys.stderr)
        return 1

    if args.provider:
        rows = [r for r in rows if r.get("provider") == args.provider]
        if not rows:
            print(f"usage: unknown provider: {args.provider}", file=sys.stderr)
            return 1

    if args.json:
        print(json.dumps(rows, indent=2))
        return 0

    if source == "live":
        label = f"live {url}"
    else:
        label = f"sqlite {args.state_dir or default_state_dir()}"
    print(f"usage-daemon — {label}")
    print()
    print(render_table(rows, width=args.width, color=color))
    return 0


# --- usage-burn: inject fake usage on a provider, for testing --------------


def burn_main(argv: list[str] | None = None) -> int:
    import httpx

    parser = argparse.ArgumentParser(
        prog="usage-burn",
        description="Artificially burn usage on a provider (tests the daemon's live display/polling).",
    )
    parser.add_argument("provider", nargs="?", default=None,
                        help="provider id (omit to pick from a list)")
    parser.add_argument("amount", nargs="?", default=None,
                        help="e.g. '5%%' (needs a capped window) or a raw number, e.g. '1000'")
    parser.add_argument("--window", default=None, help="window id to burn (default: the primary window)")
    parser.add_argument("--url", default=None, help="live daemon base URL (default http://127.0.0.1:<port>)")
    parser.add_argument("--port", type=int, default=None, help="live daemon port (default: config.toml port or 8787)")
    args = parser.parse_args(argv)

    port = args.port or _config_port() or 8787
    url = (args.url or f"http://127.0.0.1:{port}").rstrip("/")

    rows = _fetch_live_rows(url)
    if rows is None:
        print(f"usage-burn: daemon not reachable at {url}", file=sys.stderr)
        return 1

    provider = args.provider
    if not provider:
        for i, r in enumerate(rows, 1):
            label = r.get("provider")
            print(f"  {i}. {label}")
        choice = input("select a provider (number or id): ").strip()
        if choice.isdigit() and 1 <= int(choice) <= len(rows):
            provider = rows[int(choice) - 1].get("provider")
        else:
            provider = choice
    if not any(r.get("provider") == provider for r in rows):
        print(f"usage-burn: unknown provider: {provider}", file=sys.stderr)
        return 1

    amount = args.amount
    if not amount:
        amount = input(f"amount to burn on {provider} (e.g. '5%' or '1000'): ").strip()
    if not amount:
        print("usage-burn: empty amount", file=sys.stderr)
        return 1

    try:
        res = httpx.post(
            f"{url}/usage/{provider}/burn",
            json={"amount": amount, "window": args.window},
            timeout=LIVE_TIMEOUT_S,
            trust_env=False,
        )
    except Exception as e:
        print(f"usage-burn: request failed: {e}", file=sys.stderr)
        return 1
    if res.status_code != 200:
        print(f"usage-burn: {res.status_code} {res.text}", file=sys.stderr)
        return 1

    snap = res.json()
    color = sys.stdout.isatty() and not os.environ.get("NO_COLOR")
    windows = snap.get("windows") or []
    target = next((w for w in windows if w.get("id") == args.window), None) if args.window else (windows[0] if windows else None)
    if target:
        print(" ".join(_window_segments(target, color)))
    print(f"burned {amount} on {provider} — real poll will overwrite this on its normal interval,"
          f" or force it now: curl -X POST {url}/usage/{provider}/refresh")
    return 0


if __name__ == "__main__":
    sys.exit(main())
