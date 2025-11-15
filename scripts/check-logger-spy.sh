#!/usr/bin/env bash
set -euo pipefail

# Grep for direct logger method assignments in tests. This script prints
# offending lines and exits non-zero if any are found. Developers should
# use `spyLoggerMethod` instead of directly assigning `logger.info|warn|error|debug`.

root=$(cd "$(dirname "$0")/.." && pwd)
echo "Searching for direct logger monkey-patches in tests..."

matches=$(grep -RIn --line-number --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=backend/dist --include="tests/**" -E "\b(logger|loggerMod|loggerModule)(?:\.default)?\.(info|warn|error|debug)\s*=\s*" || true)

if [ -n "$matches" ]; then
  echo "Found direct logger assignments (tests should prefer tests/utils/spyLoggerSafely.ts):"
  echo "$matches"
  exit 2
else
  echo "No direct logger method assignments found in tests. OK."
fi

exit 0
