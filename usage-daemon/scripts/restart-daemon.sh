#!/usr/bin/env bash
# Runs ON the target host (dev VM over SSH, or locally on hyperion) as the
# account that should own the daemon process. Kills any running
# usage-daemon, then relaunches it detached with logs captured for
# debugging. PID-file based (not `pgrep -f node` pattern matching) so it
# can't accidentally kill an unrelated node process.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/usage-daemon"
mkdir -p "$RUN_DIR"
PID_FILE="$RUN_DIR/daemon.pid"
LOG_FILE="$RUN_DIR/daemon.log"

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "stopping old usage-daemon (pid $old_pid)"
    kill "$old_pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$old_pid" 2>/dev/null || break; sleep 0.2; done
    kill -0 "$old_pid" 2>/dev/null && kill -9 "$old_pid" 2>/dev/null || true
  fi
fi

echo "starting usage-daemon from $REPO"
cd "$REPO"
# setsid + disown so it survives the SSH session tearing down; nohup alone
# is not reliable under `ssh host cmd` (non-interactive, no tty) — setsid
# gives it its own session so SIGHUP on disconnect can't reach it.
setsid nohup node src/index.js >>"$LOG_FILE" 2>&1 < /dev/null &
new_pid=$!
disown
echo "$new_pid" > "$PID_FILE"
sleep 0.5
if kill -0 "$new_pid" 2>/dev/null; then
  echo "usage-daemon running (pid $new_pid), logs: $LOG_FILE"
else
  echo "usage-daemon FAILED to start — see $LOG_FILE" >&2
  tail -n 40 "$LOG_FILE" >&2 || true
  exit 1
fi
