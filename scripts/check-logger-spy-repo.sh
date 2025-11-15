#!/bin/bash
set -euo pipefail

dir="${1:-.}"
allowlist_file="scripts/logger-spy-allowlist.txt"

echo "Searching for direct logger method assignments in repo (allowlist: $allowlist_file)..."

# Read allowlist entries
allowlist=""
if [ -f "$allowlist_file" ]; then
  while read -r line; do
    line_trim=$(echo "$line" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
    if [ -n "$line_trim" ] && [ "${line_trim#"#"}" = "$line_trim" ]; then
      allowlist="$allowlist$line_trim:"
    fi
  done < "$allowlist_file"
fi

# Check if file is in allowlist
is_allowed() {
  local file="$1"
  [ -n "$allowlist" ] && printf "%s" "$allowlist" | grep -q "$file:" && return 0
  return 1
}

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  matches=$(git grep -n -E 'logger(\.default)?\.(info|warn|error|debug)\s*=\s*[^=]' -- "$dir" || true)
else
  matches=$(grep -RIn --exclude-dir={node_modules,.git,dist,build} -E 'logger(\.default)?\.(info|warn|error|debug)\s*=\s*[^=]' "$dir" || true)
fi

# Filter out allowed files
violations=""
if [ -n "$matches" ]; then
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      file=$(echo "$line" | cut -d: -f1)
      if ! is_allowed "$file"; then
        violations="$violations$line\n"
      fi
    fi
  done <<< "$matches"
fi

if [ -n "$violations" ]; then
  printf "%b" "$violations"
  echo
  echo "ERROR: Direct logger method assignments found (non-allowlisted). Use tests/utils/spyLoggerSafely.ts spyLoggerMethod() instead."
  exit 1
else
  echo "No non-allowlisted direct logger method assignments found. OK."
  exit 0
fi
