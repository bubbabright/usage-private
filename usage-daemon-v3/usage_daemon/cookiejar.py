"""Read a provider's session cookie out of Firefox, on request (port of
src/cookiejar.js).

ON DEMAND, NEVER ON A TIMER. The daemon touches the Firefox profile only when a
human explicitly asks (Runner.refresh_cookie_from_firefox), never on a poll.

Mechanics:
  - Firefox stores cookie values in PLAINTEXT (no OS-keyring decrypt).
  - The DB is copied to a temp dir before opening: Firefox keeps it in WAL mode
    while running and a read-only open can fail when SQLite wants to recover the
    WAL. Copying also guarantees we never disturb Firefox's state.

Cookie VALUES are secrets: returned to the caller for the outbound request,
never logged. Log lines carry counts/hostnames/expiry only.
"""

from __future__ import annotations

import math
import os
import shutil
import sqlite3
import tempfile
import time

from .log import log


def firefox_root() -> str:
    return os.environ.get("USAGE_FIREFOX_DIR") or os.path.join(
        os.path.expanduser("~"), ".mozilla", "firefox"
    )


def find_profile_db(root: str | None = None) -> dict | None:
    """Pick the live profile: prefer default-release, else most-recently-modified."""
    root = root or firefox_root()
    if not os.path.isdir(root):
        return None
    candidates = []
    for entry in os.listdir(root):
        db = os.path.join(root, entry, "cookies.sqlite")
        if not os.path.isfile(db):
            continue
        try:
            mtime = os.path.getmtime(db)
        except OSError:
            mtime = 0
        candidates.append({"profile": entry, "db": db, "mtime": mtime})
    if not candidates:
        return None
    candidates.sort(key=lambda c: (c["profile"].count("default-release") > 0, c["mtime"]), reverse=True)
    return candidates[0]


def host_matches(cookie_host, domain: str) -> bool:
    h = (cookie_host or "").lstrip(".").lower()
    d = (domain or "").lower()
    if not h or not d:
        return False
    return h == d or h.endswith("." + d)


def to_epoch_seconds(expiry):
    """Normalize moz_cookies.expiry (units vary by Firefox version) to seconds.

    Fail-soft like the JS toEpochSeconds: junk (null, strings, NaN, Infinity,
    non-positive) has no expiry — NaN/Inf must not slip through the numeric
    branches (NaN <= 0 is False in Python) and poison expiry math.
    """
    if isinstance(expiry, bool) or not isinstance(expiry, (int, float)):
        return None
    if not math.isfinite(expiry) or expiry <= 0:
        return None
    if expiry < 1e11:
        return expiry  # seconds
    if expiry < 1e14:
        return expiry / 1e3  # milliseconds
    return expiry / 1e6  # microseconds


def to_cookie_header(rows) -> str:
    seen: dict[str, str] = {}
    for r in rows:
        if not r.get("name"):
            continue
        seen[r["name"]] = r.get("value") or ""
    return "; ".join(f"{k}={v}" for k, v in seen.items())


def soonest_expiry(rows) -> str | None:
    stamps = [to_epoch_seconds(r.get("expiry")) for r in rows]
    stamps = [s for s in stamps if s is not None]
    if not stamps:
        return None
    tm = min(stamps)
    from datetime import datetime, timezone

    return datetime.fromtimestamp(tm, timezone.utc).isoformat()


def _read_rows(db_path: str, domain: str) -> list[dict]:
    tmp_dir = tempfile.mkdtemp(prefix="usage-daemon-cookies-")
    copy = os.path.join(tmp_dir, "cookies.sqlite")
    rows = []
    try:
        shutil.copy2(db_path, copy)
        for suffix in ("-wal", "-shm"):
            if os.path.exists(db_path + suffix):
                try:
                    shutil.copy2(db_path + suffix, copy + suffix)
                except OSError:
                    pass
        conn = sqlite3.connect(f"file:{copy}?mode=ro", uri=True, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            # Shortest host first so bare-domain rows land before subdomain rows
            # that should override them in to_cookie_header().
            cur = conn.execute(
                "SELECT host, name, value, expiry FROM moz_cookies "
                "WHERE host LIKE ? OR host LIKE ? "
                "ORDER BY length(host) ASC",
                (f"%{domain}", f"%.{domain}"),
            )
            for r in cur.fetchall():
                rows.append(dict(r))
        finally:
            conn.close()
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    return rows


def cookie_header_for(domain: str) -> dict:
    """Build the Cookie header for `domain` from Firefox's store."""
    empty = {"header": "", "expiresAt": None, "count": 0}
    profile = find_profile_db()
    if profile is None:
        log.warn("firefox cookie source: no profile found", {"root": firefox_root(), "domain": domain})
        return empty
    try:
        rows = _read_rows(profile["db"], domain)
    except Exception as err:
        log.warn("firefox cookie source: could not read cookie db", {
            "domain": domain, "profile": profile["profile"], "err": err,
        })
        return empty

    now = time.time()
    matching = [r for r in rows if host_matches(r.get("host"), domain)]
    live = []
    for r in matching:
        exp = to_epoch_seconds(r.get("expiry"))
        if exp is None or exp > now:
            live.append(r)
    expired = [r for r in matching if r not in live]
    header = to_cookie_header(live)

    if not header:
        log.warn("firefox cookie source: no live cookies for domain", {
            "domain": domain, "profile": profile["profile"],
            "matched": len(matching), "expired": len(expired),
            "hint": f"log in to {domain} in Firefox",
        })
        return empty

    new_names = list({r.get("host") for r in live})
    log.info("firefox cookie source: built header", {
        "domain": domain,
        "profile": profile["profile"],
        "hosts": ",".join(sorted(new_names)),
        "cookies": ",".join(r.get("name", "") for r in live),
        "dropped_expired": ",".join(r.get("name", "") for r in expired) or None,
        "expires_at": soonest_expiry(live) or "session-only",
    })
    return {
        "header": header,
        "expiresAt": soonest_expiry(live),
        "count": len(live),
        "profile": profile["profile"],
        "names": [r.get("name", "") for r in live],
    }