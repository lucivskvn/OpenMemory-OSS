#!/usr/bin/env bash
set -euo pipefail

# Unified automation wrapper for common developer workflows
# - Adds a single entrypoint for prepush, containerized E2E, resource checks, install suggestions, and verification
# - Designed to be idempotent and non-destructive when invoked with --help

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "$(pwd)")
cd "$ROOT"

if [ -f "$ROOT/scripts/container-tools.sh" ]; then
  # shellcheck source=/dev/null
  source "$ROOT/scripts/container-tools.sh"
fi

function show_help() {
  cat <<'EOF'
Usage: automation.sh <command> [--flags]

Commands:
  help                        Show this help
  prepush [--fast|--parallel] Run the pre-push checks (wrapper for scripts/pre-push-checks.sh)
  prepush:containers           Run pre-push checks with containerized E2E early
  e2e:containers [--smoke]    Run scripts/e2e-containers.sh (smoke if --smoke)
  verify                      Run verification steps (dashboard verify + lint)
  check-resources             Run system resource check (scripts/check-system-resources.sh)
  suggest-system              Print OS-specific setup / QoS suggestions
  install-hooks               Setup git hooks (package.json install-hooks alias)

Examples:
  ./scripts/automation.sh prepush --fast
  ./scripts/automation.sh e2e:containers --smoke
  ./scripts/automation.sh suggest-system

This is a thin convenience wrapper for existing scripts in the scripts/ directory.
EOF
}

if [ $# -lt 1 ]; then
  show_help
  exit 1
fi

cmd=$1; shift || true

case "$cmd" in
  help|-h|--help)
    show_help
    ;;

  prepush)
    flags="$*"
    echo "[automation] Running pre-push checks: $flags"
    # pass flags through to existing script
    PREPUSH_ARGS="${flags}"
    bash "$ROOT/scripts/pre-push-checks.sh" ${PREPUSH_ARGS}
    ;;

  prepush:containers)
    # Explicitly run containerized prepush (runs light pre-push but triggers e2e containers early)
    echo "[automation] Starting pre-push with containerized E2E (early)..."
    RUN_CONTAINER_E2E=1 SKIP_HEAVY=1 bash "$ROOT/scripts/pre-push-checks.sh"
    ;;

  e2e:containers)
    if [[ " $* " == *"--smoke"* ]] || [[ " $* " == *"--smoke-only"* ]] || [[ " $* " == *"--critical-only"* ]]; then
      echo "[automation] Running E2E containers (smoke mode)"
      CRITICAL_ONLY=1 bash "$ROOT/scripts/e2e-containers.sh"
    else
      echo "[automation] Running E2E containers (full)"
      bash "$ROOT/scripts/e2e-containers.sh"
    fi
    ;;

  verify)
    echo "[automation] Running verification: dashboard verify + lint"
    (cd dashboard && OM_VERIFY_STRICT=1 bun run verify:ai-sdk) && (cd dashboard && bun run lint)
    ;;

  check-resources)
    if [ -x "$ROOT/scripts/check-system-resources.sh" ]; then
      bash "$ROOT/scripts/check-system-resources.sh"
    else
      echo "[automation] Resource checker missing: $ROOT/scripts/check-system-resources.sh"
      exit 2
    fi
    ;;

  suggest-system)
    if type suggest_install_instructions >/dev/null 2>&1; then
      suggest_install_instructions
    elif [ -x "$ROOT/scripts/system-suggestions.sh" ]; then
      bash "$ROOT/scripts/system-suggestions.sh"
    else
      echo "[automation] No suggestion helper found. See scripts/container-tools.sh for fallback guidance."
      exit 2
    fi
    ;;

  install-hooks)
    echo "[automation] Installing git hooks"
    git config core.hooksPath .githooks || true
    chmod +x .githooks/pre-commit .githooks/pre-push || true
    echo "[automation] Done."
    ;;

  *)
    echo "Unknown command: $cmd" >&2
    show_help
    exit 2
    ;;
esac

exit 0
