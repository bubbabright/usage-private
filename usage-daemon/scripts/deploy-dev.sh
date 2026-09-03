#!/usr/bin/env bash
# Sync usage-daemon to the dev VM and (re)launch it as daniel in the
# background, killing any prior instance first. No reboot here — daemon-only
# iteration should be fast.
#
# Usage: scripts/deploy-dev.sh [--no-restart]
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO/../scripts/deploy-common.sh"

REMOTE_DIR="$DEV_HOME/dev/usage-daemon"
RESTART=1
for arg in "$@"; do
  case "$arg" in
    --no-restart) RESTART=0 ;;
    -h|--help) echo "usage: $0 [--no-restart]"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

echo "==> rsyncing $REPO -> ${DEV_USER_HOST}:${REMOTE_DIR}"
ssh_daniel "mkdir -p '$REMOTE_DIR'"
rsync_to_dev "$REPO" "$REMOTE_DIR"

[[ "$RESTART" -eq 1 ]] || { echo "==> --no-restart: code synced, daemon left as-is"; exit 0; }

echo "==> restarting usage-daemon on $DEV_HOST as $DEV_USER"
ssh_daniel "'$REMOTE_DIR/scripts/restart-daemon.sh'"
