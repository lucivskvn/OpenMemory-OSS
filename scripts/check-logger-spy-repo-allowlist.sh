#!/bin/bash
echo "Repo checker with allowlist (simplified)..."
if git grep -n -E "logger(\\.default)?\\.(info|warn|error|debug)\\s*=\\s*[^=]" | grep -v "tests/backend/crypto.test.ts"; then
  echo "ERROR: Non-allowlisted logger assignments found"
  exit 1
else
  echo "OK: No non-allowlisted logger assignments"
  exit 0
fi
