#!/usr/bin/env bash
# usage-daemon installer / updater — safe to run via:
#   curl -fsSL https://raw.githubusercontent.com/bubbabright/usage-daemon/main/install.sh | bash
# or locally as ./install.sh from any directory (it does NOT install itself
# from the current checkout — it always clones/updates a standard, separate
# copy so this works identically piped or local).
#
# Idempotent: re-running this script IS how you update. It clones on first
# run, `git pull --ff-only` on every run after. Never touches an existing
# config.toml. Never assumes ${BASH_SOURCE[0]} points at a real checkout
# (breaks under curl | bash) — everything is derived from $HOME / $XDG_*.
set -euo pipefail

REPO_URL="https://github.com/bubbabright/usage-daemon.git"
INSTALL_DIR="${INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/usage-daemon}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/usage-daemon"
CONFIG_FILE="$CONFIG_DIR/config.toml"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/usage-daemon.service"

echo "==> checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "usage-daemon requires Node.js >= 20, but 'node' was not found on PATH." >&2
  echo "Install Node 20+ (nvm, your OS package manager, or nodejs.org) and re-run this script." >&2
  exit 1
fi
node_major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [[ "$node_major" -lt 20 ]]; then
  echo "usage-daemon requires Node.js >= 20; found $(node -v) at $(command -v node)." >&2
  exit 1
fi
echo "    node $(node -v) at $(command -v node)"

echo "==> installing/updating usage-daemon code at $INSTALL_DIR"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  if [[ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]]; then
    echo "install.sh: $INSTALL_DIR has local changes — refusing to pull. Stash/commit first." >&2
    git -C "$INSTALL_DIR" status --short >&2
    exit 1
  fi
  branch="$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD)"
  git -C "$INSTALL_DIR" pull --ff-only origin "$branch"
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

echo "==> bootstrapping config"
if [[ ! -f "$CONFIG_FILE" ]]; then
  mkdir -p "$CONFIG_DIR"
  cp "$INSTALL_DIR/config.example.toml" "$CONFIG_FILE"
  echo "    wrote default config to $CONFIG_FILE (edit to enable/configure providers)"
else
  echo "    existing config found at $CONFIG_FILE, leaving untouched"
fi

echo "==> configuring service"
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  mkdir -p "$UNIT_DIR"
  cat >"$UNIT_FILE" <<EOF
[Unit]
Description=usage-daemon (localhost usage polling for GNOME usage extensions)

[Service]
Type=simple
ExecStart=$NODE_BIN $INSTALL_DIR/src/index.js
WorkingDirectory=$INSTALL_DIR
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  if systemctl --user is-active --quiet usage-daemon.service; then
    echo "    restarting usage-daemon (picking up updated code)"
    systemctl --user restart usage-daemon.service
  else
    echo "    enabling + starting usage-daemon"
    systemctl --user enable --now usage-daemon.service
  fi
  echo
  echo "==> done. usage-daemon is running under systemd --user."
  echo "    logs:   journalctl --user -u usage-daemon -f"
  echo "    status: systemctl --user status usage-daemon"
else
  echo "    systemd --user not available on this host; code installed, not auto-started."
  echo
  echo "==> done. Start it manually:"
  echo "    cd $INSTALL_DIR && node src/index.js"
fi
echo "    config: $CONFIG_FILE"
echo "    re-run this script any time to update."
