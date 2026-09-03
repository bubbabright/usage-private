# Review — crash diagnosis, logging, and code audit (2026-08-18)

Scope: `usage-daemon/src/**` plus the `usage-web-ui` daemon-control panel.
Trigger: "daemon keeps crashing, ensure logging is robust."
Result: shipped as **v0.4.0** (web UI `0.1.2`). Tests: 289 pass / 0 fail.

---

## 1. Why the crashes were undiagnosable

The daemon was started as:

```bash
cd /mnt/nas/projects/usage/usage-daemon && nohup node src/index.js > /tmp/usage-daemon.log 2>&1 &
```

Three separate defects compounded into "it just vanishes":

| # | Defect | Consequence |
|---|--------|-------------|
| 1 | `>` **truncates** | Every restart destroyed the previous run's evidence. A repeating crash could never accumulate a record. |
| 2 | No timestamps anywhere | Time of death could only be inferred from file mtime. |
| 3 | Nothing logged an exit | `process.exit(0)`, a signal, and an external `SIGKILL` all looked identical: silence. |
| 4 | No supervisor | Once down, it stayed down until noticed by hand. |
| 5 | `/tmp` | A reboot wipes the only log that existed. |

Two deaths were observed live during this review (00:09 and ~00:19:22). Both were
**instant and silent** mid-normal-poll: no stack trace, no OOM entry in the kernel log,
no second boot banner. Ruled out by that evidence: uncaught exception (would print a
stack), OOM killer (nothing in the journal), and the restart→respawn path (the child
inherits the same append fd, so a second boot banner would appear).

What remains, and cannot be separated after the fact because nothing logged an exit:

- **External `SIGKILL` / process-group reap — best fit for both observed deaths.**
  `nohup` protects against `SIGHUP`, not against the whole process group being killed
  when the shell session that spawned it is torn down. Both deaths came ~2–3 minutes
  after a hand-started `nohup … &` from a session shell, and both left *nothing* — no
  stack, no exit line, no kernel entry. That is exactly the shape of a group `SIGKILL`.
  Supporting datapoint: since moving to systemd the daemon sits in its own cgroup and
  has survived every deliberate restart, staying up in between.
- **`POST /usage/admin/stop`** → `process.exit(0)` with *zero* output. Possible, not
  favoured (it needs a human pressing Stop in the web UI, twice, inside ten minutes).
  Worth naming anyway because the hole is real: `[control] allow_control = true`, bound
  to `0.0.0.0` with **no per-request auth**, and the UI ships a Stop button — so any
  browser on the LAN *could* kill it with no trace. It is now logged with caller IP if
  it ever happens.

Both are now either recorded or structurally prevented. The honest finding is that the
old setup was **undiagnosable by construction** — so the work went into making the next
one diagnosable rather than into more forensics on evidence that no longer exists.

---

## 2. What shipped

### 2.1 `src/log.js` — durable logging (new)

- Timestamped (local time **with offset**), level-tagged, `key=value` context fields
  that stay greppable (values with spaces quoted, newlines flattened, `Error` → stack).
- **Every write is `appendFileSync`.** This is the load-bearing detail: an async
  `fs.appendFile` or a buffered stream write scheduled inside an `exit` /
  `uncaughtException` handler *never lands on disk*. Volume is a handful of lines per
  poll cycle, so sync costs nothing and buys durability.
- Default file `~/.local/state/usage-daemon/daemon.log` — **not `/tmp`**.
- Self-rotating by size (5 MiB, keeps 3) so an unattended daemon can't fill the disk.
- Writes to the file **and** stderr (= journald under systemd).
- A broken log path degrades to stderr-only instead of throwing. A logger must never be
  the thing that kills the process it exists to observe.
- Configurable via `[logging]` in `config.toml` or `USAGE_LOG_*` env vars (env wins —
  the escape hatch for when the config itself is what's broken).

### 2.2 Every exit path is now logged

`installProcessHandlers()` is installed at module scope in `index.js`, *before* config
load, so a startup failure is recorded too:

| Path | Was | Now |
|------|-----|-----|
| uncaught exception | Node's default dump, nothing on disk after a truncate | `FATAL uncaught exception err="<stack>"` |
| unhandled rejection | hard exit, no record | `FATAL unhandled promise rejection` |
| SIGTERM/INT/HUP/QUIT | one untimestamped line, signal unnamed | `WARN received signal, shutting down signal=SIGTERM` |
| `process.exit()` anywhere (incl. `admin/stop`) | **total silence** | `FATAL process exiting code=0 uptime_s=185` |
| event loop drained | silent code-0 exit | `WARN event loop drained…` |
| `SIGKILL` | silence | still silence — **and that is now the diagnosis**: no exit line = something SIGKILLed us |

Verified live:

```
00:25:39 WARN  usage-daemon: received signal, shutting down signal=SIGTERM
00:25:39 FATAL usage-daemon: process exiting code=0 uptime_s=185
00:25:39 INFO  usage-daemon: daemon starting version=0.4.0 pid=289243 node=v24.16.0 …
```

### 2.3 Supervised startup (the actual answer to "keeps crashing")

The repo already contained a correct `usage-daemon.service` with `Restart=always` —
**it was never installed.** Installed at `~/.config/systemd/user/usage-daemon.service`,
enabled, started. `loginctl` linger was already on, so it survives logout and boot.

```bash
systemctl --user status usage-daemon
journalctl --user -u usage-daemon -n 50 --no-pager
tail -f ~/.local/state/usage-daemon/daemon.log
```

Also: systemd itself records `code=killed, signal=KILL` — which closes the one gap the
in-process logger cannot cover.

**Exactly one daemon** (`ss -tlnp | grep 8787`). Do not hand-start a second.

### 2.4 Bugs fixed

| Severity | File | Bug | Fix |
|---|---|---|---|
| 🔴 High | `http.js`, `store.js` | **Path traversal + junk-dir creation.** `:provider` was never validated; `store.stateDir()` does a bare `path.join(base, provider)`, and `read()` → `migrateLegacyHistory()` → `mkdir` + marker write. So `GET /usage/<anything>/history` *created* a state directory, and `..%2f..%2f` escaped the state dir for both the mkdir and the file read. The icon routes built filenames from the same segment. | One `router.param('provider')` allowlist check against the runner's own map + a name regex. Confirmed: unknown → 404, traversal → 404, known → 200. (This is where the stray `~/.local/state/usage-daemon/throttled/` came from; removed.) |
| 🔴 High | `index.js` | **Unhandled `'error'` event on the HTTP server.** `EADDRINUSE` threw out of the event loop with nothing explaining it. | `server.on('error')` handler; `EADDRINUSE` retries ~6s (the restart route's own race) then refuses to start rather than spinning — never two daemons on one port. |
| 🟠 Med | `http.js` | **Restart race.** The restart route spawned the replacement *before* releasing the socket, so the child hit `EADDRINUSE` and died instantly — leaving nothing running. | Close the listener first, then spawn; child also gets the listen-retry above and `USAGE_LOG_STDERR=0` so it doesn't double-write. |
| 🟠 Med | `http.js` | `admin/stop` and `admin/restart` were completely unlogged. | Logged with action, caller IP, and user-agent, *before* acting, and the stop line states whether it is supervised. |
| 🟠 Med | `store.js` | **Whole-history re-read on every poll and on every `/headline` request** — ~400 KB parsed × 10 providers, per request, for files that change once per poll interval. Matches the 123 MB peak in the old journal. | mtime+size-keyed parse cache. `/headline` measured 28 ms → 4 ms. A cache hit hands back the *same* array, so consumers must not mutate it — verified: no `sort`/`reverse`/`splice`/`push`/`shift`/`pop` against history rows anywhere in `headline.js`, `burnrate.js`, or `history-utils.js`. |
| 🟠 Med | `http.js` | **`admin/restart` raced systemd.** It closed the socket, spawned a detached replacement, then exited — but a detached child stays in the service cgroup, so systemd SIGTERMed it while starting its own instance. Observed live: child `292325` spawned, killed, unit restarted anyway. | Under systemd, skip the respawn entirely and just exit — `Restart=always` owns it. Verified: one process, no port-busy retries, no orphan child. `admin/stop`'s log line and hint are also systemd-aware now (a stop is a ~5 s blip, not a shutdown; `systemctl --user stop usage-daemon` is the real one). |
| 🟡 Low | `http.js` | Default log target `/tmp/usage-daemon.log`, and `startHint` actively taught the truncating `>` form. | Default = the logger's own file; hint is `systemctl --user start usage-daemon`, and the nohup fallback redirects to `/dev/null` (the daemon owns its log now). |
| 🟡 Low | `config.js` | `configPath()` computed a `legacy` path it never used. | Removed. |
| 🟡 Low | `index.js`, `http.js` | `~` in `logging.file` / `control.log_file` was never expanded. | Run through `expandHome()`. |
| 🟡 Low | `http.js` | No terminal error handler; a rejected async handler produced a bare HTML error page with nothing logged. | Error middleware → JSON 500 + logged stack. |

### 2.5 Tests

`test/log.test.js` (7) and `test/store.test.js` (5) added — write/format/level/rotation/
degrade-on-unwritable, and cache-invalidated-by-append. **289 pass, 0 fail.**

### 2.6 Docs

`AGENTS.md` (both levels) rewritten: the "ignore systemctl, it's an ad-hoc nohup
process" gotcha is resolved and replaced with the real workflow, keeping a historical
note on why the old warning existed. `config.example.toml` gained `[logging]`. The web
UI's hardcoded nohup/`/tmp` hints now point at `systemctl` / `journalctl`.

---

## 3. Open findings — NOT fixed, deliberate

1. **`allow_control = true` + no auth on `0.0.0.0` — WON'T FIX, decided 2026-08-18.**
   A loopback-only gate was built and tested, then deliberately reverted. Reasons:
   the home router has zero open WAN ports, the host is LAN/Tailscale-only, and the
   dashboard reaches the daemon *through the vite proxy on this same box* — so any
   origin gate strict enough to matter would have broken the UI's own buttons for no
   real-world gain. What stands instead: every admin action is logged with caller IP
   and user-agent, and `Restart=always` means even a Stop is a ~5 s blip rather than a
   permanent kill. Verified end-to-end through the dashboard proxy: Stop → daemon
   exits → systemd restarts it → healthy 9 s later, entire sequence in the log.
2. ~~🟠 **`codexbar` shells out to the `claude` CLI every 300 s**~~ — **REMOVED
   2026-08-18** (v0.5.0). Plugin, test, fixtures, config blocks, and docs all deleted;
   the web UI's icon entry went with it. Measured before/after: 290 MB peak with a
   `claude` subprocess per poll → **44.7 MB, zero child processes**. Inspection before
   removal showed it was only returning Claude's 5h/7d numbers — a second, far more
   expensive read of what the native `claude` plugin already provides, minus its
   `extra_usage` (Usage Credits) window. Original finding follows.

   Original: **`codexbar` shells out to the `claude` CLI every 300 s** (observed: a full
   `claude --allowed-tools ""` subprocess as a daemon child, ~290 MB RSS peak on that
   host). It is bounded (30 s timeout, 4 MiB maxBuffer) so it is not a leak, but it is
   by far the heaviest thing the daemon does, and on a box already at 24.7/31 GB used it
   is the most plausible OOM trigger if one ever occurs. Consider the `codexbar serve`
   HTTP path (the plugin's preferred source) or a longer interval.
3. 🟡 `config.js`'s minimal TOML reader strips `#` to end-of-line **even inside a quoted
   string** — a secret or URL containing ` #` would be silently truncated. No current
   value hits it. Swap for a real parser if config grows.
4. 🟡 `dashboard.js` / `report.js` still unwired; `GET /` is a live 404 (already known,
   still open in `PLAN-daemon-webui-stability.md`).
5. 🟡 `store.trim()` rewrites the entire file on every append once past 20k lines.
   Fine today; O(n)-per-poll if history ever grows.
6. 🟡 Repo clutter: `usage-daemon-modern/`, `BACKUP-20260720-234138/`,
   `BACKUP-history-merge-20260801-055045/`, `archive/`, and a `bun.lock` alongside
   `package-lock.json`. Dead weight when grepping.

---

## 4. How to diagnose the next one

```bash
systemctl --user status usage-daemon           # Restart=always: it should already be back
journalctl --user -u usage-daemon -n 100 --no-pager
grep -E 'FATAL|WARN' ~/.local/state/usage-daemon/daemon.log | tail -30
```

Read it like this:

- `FATAL process exiting code=0` right after `WARN admin action requested action=stop`
  → **someone pressed Stop in the web UI** (the IP is on the same line).
- `FATAL uncaught exception` / `unhandled promise rejection` → a real code bug, stack
  included.
- `WARN received signal … signal=SIGTERM` → something asked it to stop (systemd
  restart, reboot).
- **No exit line at all**, and systemd says `code=killed, signal=KILL` → killed from
  outside (OOM killer, or a process-group reap from whatever shell started it).
- `WARN event loop drained` → the listening socket was lost without an explicit exit.
