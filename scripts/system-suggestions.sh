#!/usr/bin/env bash
set -euo pipefail
# One-time helper to print OS-specific install & QoS suggestions for container tools
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "$(pwd)")
if [ -f "$ROOT/scripts/container-tools.sh" ]; then
  # shellcheck source=/dev/null
  source "$ROOT/scripts/container-tools.sh"
fi

if type suggest_install_instructions >/dev/null 2>&1; then
  suggest_install_instructions
else
  echo "No suggestion helper available. See https://docs.docker.com/get-docker/ and https://podman.io/getting-started" >&2
  exit 1
fi
