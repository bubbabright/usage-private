"""Storage layer (port of src/store.js onto SQLite).

Two files in the state dir:
  usage.sqlite   snapshots + window_series + state — the only DB the HTTP layer
                 ever touches.
  secrets.sqlite credentials (cookies / tokens / oauth payloads); NEVER returned
                 over HTTP and never read by the HTTP layer.

History is unbounded (the JSONL 20k cap is gone). WAL mode. Async callers use
the `async_` facade methods, which push the synchronous sqlite work onto the
event loop's default executor (to_thread) guarded by a single writer lock.
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import threading

_SCHEMA_USAGE = """
CREATE TABLE IF NOT EXISTS snapshots (
  provider TEXT NOT NULL,
  t INTEGER NOT NULL,
  tier TEXT,
  row TEXT NOT NULL,
  PRIMARY KEY(provider, t)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_provider_t ON snapshots(provider, t);
CREATE TABLE IF NOT EXISTS window_series (
  provider TEXT NOT NULL,
  window_id TEXT NOT NULL,
  t INTEGER NOT NULL,
  pct REAL
);
CREATE INDEX IF NOT EXISTS idx_window_series ON window_series(provider, window_id, t);
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT
);
"""

_SCHEMA_SECRETS = """
CREATE TABLE IF NOT EXISTS secrets (
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(provider, kind)
);
"""


def default_state_dir() -> str:
    xdg = os.environ.get("XDG_STATE_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "state"
    )
    return os.environ.get("USAGE_STATE_DIR") or os.path.join(xdg, "usage-daemon")


def history_row(snapshot: dict) -> dict:
    """Flatten a snapshot's windows into the compact history row contract."""
    row: dict = {"t": snapshot["t"], "tier": snapshot.get("tier")}
    for w in snapshot.get("windows", []):
        p = w.get("pct")
        if isinstance(p, (int, float)):
            row[w["id"]] = p
    return row


class _C:
    """Namespace for known state keys (avoids magic strings scattered around)."""

    LEGACY_PREFIX = "legacy-migrated:"
    URLS_KEY = "usage-urls"
    DAEMON_ID = "daemon-id"
    DAEMON_VERSION = "daemon-version"


class Store:
    """SQLite-backed history + window series + state + secrets."""

    def __init__(self, state_dir: str | None = None) -> None:
        self.dir = state_dir or default_state_dir()
        os.makedirs(self.dir, exist_ok=True)
        self.usage_path = os.path.join(self.dir, "usage.sqlite")
        self.secrets_path = os.path.join(self.dir, "secrets.sqlite")
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None
        self._secrets_conn: sqlite3.Connection | None = None
        self._cache: dict[str, dict] = {}  # provider -> {version, rows}
        self._versions: dict[str, int] = {}
        self._migrated: set[str] = set()

    def _usage(self) -> sqlite3.Connection:
        if self._conn is None:
            conn = sqlite3.connect(self.usage_path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(_SCHEMA_USAGE)
            conn.commit()
            self._conn = conn
        return self._conn

    def _secrets(self) -> sqlite3.Connection:
        if self._secrets_conn is None:
            conn = sqlite3.connect(self.secrets_path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(_SCHEMA_SECRETS)
            conn.commit()
            try:
                os.chmod(self.secrets_path, 0o600)
            except OSError:
                pass
            self._secrets_conn = conn
        return self._secrets_conn

    def _migrate_legacy_history(self, provider: str) -> None:
        """One-time merge of a cwd-relative history.jsonl into sqlite."""
        if provider in self._migrated:
            return
        self._migrated.add(provider)
        marker = f"{_C.LEGACY_PREFIX}{provider}"
        cur = self._usage()
        row = cur.execute("SELECT value FROM state WHERE key=?", (marker,)).fetchone()
        if row is not None:
            return  # already handled in a previous run

        legacy_path = os.path.join(
            os.getcwd(), ".local", "state", "usage-daemon", provider, "history.jsonl"
        )
        legacy_parsed: list[dict] = []
        if os.path.exists(legacy_path):
            try:
                with open(legacy_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            legacy_parsed.append(json.loads(line))
                        except Exception:
                            continue
            except OSError:
                legacy_parsed = []

        if legacy_parsed:
            cur.executemany(
                "INSERT OR IGNORE INTO snapshots(provider, t, tier, row) VALUES (?,?,?,?)",
                [
                    (provider, int(o["t"]), o.get("tier"), json.dumps(o))
                    for o in sorted(legacy_parsed, key=lambda o: o.get("t", 0))
                ],
            )
            self._rebuild_window_series(cur, provider)
            cur.commit()
            from .log import log

            log.info(
                "migrated legacy history rows (cwd-relative -> XDG state dir)",
                {"provider": provider, "rows": len(legacy_parsed)},
            )
        cur.execute("INSERT OR REPLACE INTO state(key, value) VALUES (?, ?)", (marker, "1"))
        cur.commit()

    @staticmethod
    def _rebuild_window_series(cur: sqlite3.Cursor, provider: str) -> None:
        cur.execute("DELETE FROM window_series WHERE provider=?", (provider,))
        rows = cur.execute(
            "SELECT t, row FROM snapshots WHERE provider=? ORDER BY t", (provider,)
        ).fetchall()
        ws = []
        for r in rows:
            try:
                obj = json.loads(r["row"])
            except Exception:
                continue
            for k, v in obj.items():
                if k in ("t", "tier") or not isinstance(v, (int, float)):
                    continue
                ws.append((provider, k, obj["t"], float(v)))
        cur.executemany(
            "INSERT INTO window_series(provider, window_id, t, pct) VALUES (?,?,?,?)", ws
        )

    # --- history write ---
    def append(self, provider: str, snapshot: dict) -> None:
        """Persist a snapshot (compact history row + per-window series)."""
        row = history_row(snapshot)
        t = int(snapshot["t"])
        cur = self._usage()
        cur.execute(
            "INSERT OR REPLACE INTO snapshots(provider, t, tier, row) VALUES (?,?,?,?)",
            (provider, t, row.get("tier"), json.dumps(row)),
        )
        for k, v in row.items():
            if k in ("t", "tier") or not isinstance(v, (int, float)):
                continue
            cur.execute(
                "INSERT INTO window_series(provider, window_id, t, pct) VALUES (?,?,?,?)",
                (provider, k, t, float(v)),
            )
        cur.commit()
        self._versions[provider] = self._versions.get(provider, 0) + 1

    # --- history read (cached by provider + append version; always ordered) ---
    def read(self, provider: str) -> list[dict]:
        """Return compact history rows, oldest -> newest."""
        self._migrate_legacy_history(provider)
        version = self._versions.get(provider, 0)
        cached = self._cache.get(provider)
        if cached and cached["version"] == version:
            return cached["rows"]
        rows: list[dict] = []
        try:
            cur = self._usage()
            for r in cur.execute(
                "SELECT row FROM snapshots WHERE provider=? ORDER BY t", (provider,)
            ):
                try:
                    rows.append(json.loads(r["row"]))
                except Exception:
                    continue
        except Exception:
            rows = []
        self._cache[provider] = {"version": version, "rows": rows}
        return rows

    # --- state kv ---
    def state_get(self, key: str) -> str | None:
        try:
            r = self._usage().execute(
                "SELECT value FROM state WHERE key=?", (key,)
            ).fetchone()
            return r["value"] if r else None
        except Exception:
            return None

    def state_set(self, key: str, value: str) -> None:
        cur = self._usage()
        cur.execute("INSERT OR REPLACE INTO state(key, value) VALUES (?, ?)", (key, value))
        cur.commit()

    def state_get_json(self, key: str):
        v = self.state_get(key)
        if not v:
            return None
        try:
            return json.loads(v)
        except Exception:
            return None

    def state_set_json(self, key: str, value) -> None:
        self.state_set(key, json.dumps(value))

    # --- secrets ---
    def secret_get(self, provider: str, kind: str) -> str | None:
        try:
            r = self._secrets().execute(
                "SELECT value FROM secrets WHERE provider=? AND kind=?",
                (provider, kind),
            ).fetchone()
            return r["value"] if r else None
        except Exception:
            return None

    def secret_set(self, provider: str, kind: str, value: str) -> None:
        cur = self._secrets()
        cur.execute(
            "INSERT OR REPLACE INTO secrets(provider, kind, value) VALUES (?,?,?)",
            (provider, kind, value),
        )
        cur.commit()

    def secret_delete(self, provider: str, kind: str) -> None:
        cur = self._secrets()
        cur.execute("DELETE FROM secrets WHERE provider=? AND kind=?", (provider, kind))
        cur.commit()

    # --- async facade (all calls go through the single writer lock) ---
    def _locked(self, fn, *args):
        with self._lock:
            return fn(*args)

    async def async_append(self, provider: str, snapshot: dict) -> None:
        await asyncio.to_thread(self._locked, self.append, provider, snapshot)

    async def async_read(self, provider: str) -> list[dict]:
        return await asyncio.to_thread(self._locked, self.read, provider)

    async def async_state_get(self, key: str) -> str | None:
        return await asyncio.to_thread(self._locked, self.state_get, key)

    async def async_state_set(self, key: str, value: str) -> None:
        await asyncio.to_thread(self._locked, self.state_set, key, value)

    async def async_secret_get(self, provider: str, kind: str) -> str | None:
        return await asyncio.to_thread(self._locked, self.secret_get, provider, kind)

    async def async_secret_set(self, provider: str, kind: str, value: str) -> None:
        await asyncio.to_thread(self._locked, self.secret_set, provider, kind, value)

    async def async_secret_delete(self, provider: str, kind: str) -> None:
        await asyncio.to_thread(self._locked, self.secret_delete, provider, kind)