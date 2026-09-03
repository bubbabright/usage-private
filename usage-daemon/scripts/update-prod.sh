#!/usr/bin/env bash
# "Pull latest + restart-if-running" for hyperion. If the daemon isn't
# currently running locally, just leave the pulled source in place — don't
# force-start a persistent service (out of scope for now).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "update-prod: working tree has local changes — refusing to pull. Stash/commit first." >&2
  git status --short >&2
  exit 1
fi
echo "==> git pull ($branch)"
git pull --ff-only origin "$branch"

PID_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/usage-daemon/daemon.pid"
running_pid=""
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  running_pid="$(cat "$PID_FILE")"
elif pgrep -f "node .*usage-daemon/src/index.js" >/dev/null 2>&1; then
  # covers an already-running instance that predates the pidfile convention
  running_pid="$(pgrep -f "node .*usage-daemon/src/index.js" | head -1)"
fi

if [[ -n "$running_pid" ]]; then
  echo "==> daemon currently running (pid $running_pid) — restarting with new code"
  "$REPO/scripts/restart-daemon.sh"
else
  echo "==> daemon not currently running — source updated, not starting it (out of scope to auto-start)"
fi
