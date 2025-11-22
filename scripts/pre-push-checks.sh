function _color() {
  local code="$1"; shift
  if [ -t 1 ]; then
    printf "\e[%sm%s\e[0m" "$code" "$*"
  else
    printf "%s" "$*"
  fi
}
function info() { _color "1;34" "[INFO] $*\n"; }
## Source shared container helpers
if [ -f "$ROOT/scripts/container-tools.sh" ]; then
  # shellcheck source=/dev/null
  source "$ROOT/scripts/container-tools.sh"
fi
function ok() { _color "1;32" "[OK] $*\n"; }
function warn() { _color "1;33" "[WARN] $*\n"; }
function fatal() { _color "1;31" "[ERROR] $*\n"; exit 1; }

function prompt_yes_no() {
  local prompt="$1"; shift
  if [ "${INTERACTIVE:-0}" != "1" ]; then
    return 1
  fi
  read -p "$prompt [y/N]: " -r answer
  case "${answer}" in
    [Yy]|[Yy][Ee][Ss]) return 0 ;;
    *) return 1 ;;
  esac
}
#!/usr/bin/env bash
set -euo pipefail

# Local pre-push checks for OpenMemory
# - Runs a set of quick checks first, and optionally runs heavier integration tests
# - Allows skipping long or flakey tests using SKIP_HEAVY=1
# - Fails locally because pre-push is intended to stop broken code from being pushed

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "$(pwd)")
cd "$ROOT"

echo "Running local pre-push verification checks (strict locally)"

SKIP_HEAVY=${SKIP_HEAVY:-0}
CI_FRIENDLY=${CI_FRIENDLY:-0}
PREPUSH_FAST=${PREPUSH_FAST:-0}
PARALLEL_TESTS=${PARALLEL_TESTS:-0}

function run_dashboard_verify() {
  echo "-> dashboard: verify AI SDK (strict)"
  (cd dashboard && OM_VERIFY_STRICT=1 bun run verify:ai-sdk)
}

# Ensure required container tooling exists when container E2E requested; print clear actionable advice
function ensure_container_tooling() {
  if [ "${RUN_CONTAINER_E2E:-0}" != "1" ]; then
    return 0
  fi

  if type verify_container_tooling >/dev/null 2>&1; then
    verify_container_tooling || rc=$?
    if [ "${rc:-0}" -eq 10 ]; then
      echo "podman external provider detected; attempting lightweight fallback for ollama..."
      if type attempt_ollama_fallback >/dev/null 2>&1; then
        if attempt_ollama_fallback; then
          echo "Fallback ollama started successfully.";
          return 0
        else
          echo "Fallback failed. Printing installation suggestions and aborting." >&2
          if type suggest_install_instructions >/dev/null 2>&1; then
            suggest_install_instructions
          fi
          exit 3
        fi
      else
        echo "No fallback available and podman external provider detected. Use CONTAINER_ENGINE=docker or fix podman config." >&2
        exit 3
      fi
    fi
  else
    # legacy fallback
    if ! command -v docker >/dev/null 2>&1 && ! command -v podman >/dev/null 2>&1; then
      echo "No container CLI found. Install Docker or Podman to run containerized E2E." >&2
      exit 3
    fi
  fi
}

function run_backend_tests() {
  echo "-> backend: unit tests (fast)"
  # Use test:ci to be deterministic in local dev environment
  (cd backend && OM_DB_USER_SCOPE_WARN=false OM_TEST_MODE=1 OM_SKIP_BACKGROUND=true bun run test)
}

function run_dashboard_tests() {
  echo "-> dashboard: client tests"
  (cd dashboard && bun test)
}

function run_dashboard_build() {
  echo "-> dashboard: build"
  (cd dashboard && bun run build)
}

function run_lint() {
  echo "-> dashboard: lint"
  (cd dashboard && bun run lint)
}

info "Starting quick checks..."

# Parse args for --fast / --critical-only
for arg in "$@"; do
  case "$arg" in
    --fast|--critical-only)
      PREPUSH_FAST=1
      ;;
    --parallel)
      PARALLEL_TESTS=1
      ;;
  esac
done

# If a local resource checker exists, call it and adapt behavior on low resources
if [ -x "$ROOT/scripts/check-system-resources.sh" ]; then
  bash "$ROOT/scripts/check-system-resources.sh" || rc=$?
  if [ -n "${rc:-}" ]; then
    if [ "$rc" -eq 2 ]; then
      fatal "Critical low system resources detected. Aborting pre-push to avoid OOM. Re-run after freeing memory/swap or increase swap.";
    elif [ "$rc" -eq 1 ]; then
      warn "Low system resources detected — falling back to safer pre-push settings to avoid OOM."
      # Reduce concurrency and skip heavy tests by default to avoid OOM
      PARALLEL_TESTS=0
      PREPUSH_FAST=1
    fi
  fi
fi

if [ "$PREPUSH_FAST" -eq 1 ]; then
  info "Running FAST prepush (critical-only): lint + verify"
  # Run lint and verify in parallel to speed up feedback
  pids=()
  failures=0

  (run_lint) & pids+=("$!")
  (run_dashboard_verify) & pids+=("$!")

  for pid in "${pids[@]}"; do
    wait "$pid" || failures=$((failures + 1))
  done

  if [ "$failures" -gt 0 ]; then
    echo "Prepush fast checks failed ($failures). Aborting push." >&2
    exit 1
  fi
else
  # Default slow path: run lint + verify in parallel (fast for dev) then full tests
  pids=()
  failures=0

  (run_lint) & pids+=("$!")
  (run_dashboard_verify) & pids+=("$!")

  for pid in "${pids[@]}"; do
    wait "$pid" || failures=$((failures + 1))
  done

  if [ "$failures" -gt 0 ]; then
    fatal "Initial checks failed ($failures). Aborting push. If you expected container E2E to run set RUN_CONTAINER_E2E=1 (or run 'bun run prepush:containers') to trigger containerized tests explicitly."
    exit 1
  fi
fi

if [ "$SKIP_HEAVY" -eq 0 ]; then
  # If the developer asked for containerized E2E as part of this prepush, run it early
  if [ "${RUN_CONTAINER_E2E:-0}" = "1" ]; then
    info "RUN_CONTAINER_E2E=1 set - running containerized E2E BEFORE heavy tests"
    ensure_container_tooling
    if ! bash "$ROOT/scripts/e2e-containers.sh"; then
      echo "Containerized E2E failed - aborting push" >&2
      exit 1
    fi
  fi
  info "Running full test suite (this may take a while)..."
  if [ "$PARALLEL_TESTS" -eq 1 ]; then
    # Run heavy tests in parallel to save time on multi-core machines
    heavy_pids=()
    heavy_failures=0

    (run_backend_tests) & heavy_pids+=("$!")
    (run_dashboard_tests) & heavy_pids+=("$!")

    for pid in "${heavy_pids[@]}"; do
      wait "$pid" || heavy_failures=$((heavy_failures + 1))
    done

    if [ "$heavy_failures" -gt 0 ]; then
      echo "Some heavy tests failed ($heavy_failures). Aborting push." >&2
      echo "Tip: If you intended to run a containerized smoke test for debugging, run 'bun run prepush:containers' or 'RUN_CONTAINER_E2E=1 bun run prepush' to execute containerized E2E early." >&2
      exit 1
    fi
  else
    run_backend_tests
    run_dashboard_tests
  fi

  run_dashboard_build
else
  info "SKIP_HEAVY=1 set, skipping heavy tests (backend tests, build)"
fi

  # NOTE: containerized E2E is executed earlier when RUN_CONTAINER_E2E=1 (fast path)

info "Security scan (non-fatal)"
# Security scan is non-fatal locally
(cd backend && bun run security:scan) || true

ok "All pre-push checks passed (strict). You may push safely."
exit 0
