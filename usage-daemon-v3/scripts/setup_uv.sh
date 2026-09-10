#!/usr/bin/env bash
# Bootstrap the usage‑daemon‑v3 development environment with uv
# Requires uv (https://astral.sh/uv) to be installed.

set -euo pipefail

# Create a new isolated environment in .venv (uv default)
uv venv .venv

# Activate the environment
source .venv/bin/activate

# Install the package in editable mode
uv pip install -e .

# Install test dependencies (pytest) – defined in pyproject [dependency-groups]
uv pip install -e .[dev]

echo "✅ uv environment ready – you can now run:\n   uv run usage-daemon --help\n   uv run usage --help\n"