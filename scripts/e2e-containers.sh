#!/usr/bin/env bash
set -euo pipefail

# e2e-containers.sh
# Spins up a containerized environment using docker-compose (or Podman) to run backend and frontend tests,
# then destroys containers and removes images. This allows testing the whole stack in a containerized environment
# similar to CI, and cleans up afterwards.

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "$(pwd)")
cd "$ROOT"

# Configuration
# Environment variables (optional):
#  - CONTAINER_ENGINE: docker or podman (default: docker)
#  - COMPOSE_FILE: docker-compose file path (default: docker-compose.yml)
#  - COMPOSE_PROFILES: profiles to enable (e.g. "ollama pg")
#  - INCLUDE_OLLAMA: include ollama profile (default: 1)
#  - EMBEDDING_MODEL: Ollama model to pull (default: nomic-embed-text)
#  - EMBEDDING_MODEL_WAIT_SECONDS: base wait seconds for model to become available (default: 60)
#  - SHOW_OLLAMA_LOGS: 1 to periodically print Ollama container logs while waiting (default: 0)
#  - E2E_VERBOSE: 1 to enable extra status/progress output (default: 0)
ENGINE=${CONTAINER_ENGINE:-docker} # docker or podman
COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.yml}
PROFILES=${COMPOSE_PROFILES:-""}    # e.g., "ollama pg"
INCLUDE_OLLAMA=${INCLUDE_OLLAMA:-1}
CRITICAL_ONLY=${CRITICAL_ONLY:-0}
PULL_IMAGES=${PULL_IMAGES:-0}         # set to 1 to pull latest images first
EMBEDDING_MODEL=${EMBEDDING_MODEL:-nomic-embed-text}
EMBEDDING_MODEL_WAIT_SECONDS=${EMBEDDING_MODEL_WAIT_SECONDS:-60}
SHOW_OLLAMA_LOGS=${SHOW_OLLAMA_LOGS:-0}    # set to 1 to print periodic ollama logs during model pull
E2E_VERBOSE=${E2E_VERBOSE:-0}              # set to 1 to enable additional progress output during waits

# Build + cleanup flags (use these to ensure tests run against latest local code)
# FORCE_REBUILD=1: rebuild images from local sources before starting (default: 1)
# NO_CACHE=1: pass --no-cache to the build (default: 1)
# PRUNE_DANGLING=1: after tests finish, prune dangling images/volumes (default: 1)
FORCE_REBUILD=${FORCE_REBUILD:-1}
NO_CACHE=${NO_CACHE:-1}
PRUNE_DANGLING=${PRUNE_DANGLING:-1}

# Ensure a stable compose project name so cleanup can target the right project
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-$(basename "$ROOT")}
TEST_PROFILE=${COMPOSE_TEST_PROFILE:-test}
TIMEOUT=${E2E_TIMEOUT:-300}         # seconds to wait for service health
KEEP_CONTAINERS=${KEEP_CONTAINERS:-0} # if set will not remove containers/images after tests

echo "Running E2E container tests using engine: $ENGINE"
echo "Compose file: $COMPOSE_FILE profiles: $PROFILES"

## Source shared container helpers
if [ -f "$ROOT/scripts/container-tools.sh" ]; then
  # shellcheck source=/dev/null
  source "$ROOT/scripts/container-tools.sh"
fi

# Verify container tooling early so failures are actionable
if type verify_container_tooling >/dev/null 2>&1; then
  verify_container_tooling || rc=$?
  if [ "${rc:-0}" -eq 10 ]; then
    _ct_warn "External podman compose provider detected — attempting lightweight fallback for Ollama."
    if type attempt_ollama_fallback >/dev/null 2>&1; then
      attempt_ollama_fallback || {
        _ct_warn "Fallback attempt did not bring Ollama up; printing install suggestions and aborting."
        if type suggest_install_instructions >/dev/null 2>&1; then
          suggest_install_instructions
        fi
        exit 3
      }
    else
      _ct_fatal "No fallback available for external podman provider. Use CONTAINER_ENGINE=docker or fix podman config."
    fi
  fi
fi

# Run system resource check and adapt default flags if resources are low
if [ -x "$ROOT/scripts/check-system-resources.sh" ]; then
  bash "$ROOT/scripts/check-system-resources.sh" || rc=$?
  if [ -n "${rc:-}" ]; then
    if [ "$rc" -eq 2 ]; then
      fatal "Aborting: critical low system resources detected. Free memory/swap and retry.";
    elif [ "$rc" -eq 1 ]; then
      warn "Low system resources detected — adjusting e2e runner to be gentler to avoid OOM."
      # Be conservative: don't force rebuild and don't prune dangling images by default
      FORCE_REBUILD=0
      NO_CACHE=0
      PRUNE_DANGLING=0
      info "Adjusted flags: FORCE_REBUILD=${FORCE_REBUILD}, NO_CACHE=${NO_CACHE}, PRUNE_DANGLING=${PRUNE_DANGLING}"
    fi
  fi
fi

function run_compose() {
    if [ "$ENGINE" = "podman" ]; then
      if ! command -v podman-compose >/dev/null 2>&1; then
        echo "podman-compose not found; try 'sudo apt install podman-compose' or use CONTAINER_ENGINE=docker" >&2
        exit 3
      fi
      podman-compose -f "$COMPOSE_FILE" $@
    else
      if ! command -v docker >/dev/null 2>&1; then
        echo "docker not found; please install Docker or use CONTAINER_ENGINE=podman with podman-compose" >&2
        exit 3
      fi
      docker compose -f "$COMPOSE_FILE" $@
    fi
}

# Check container engine/tooling early and print clear instructions when missing
function verify_container_tooling() {
  local engine=${CONTAINER_ENGINE:-docker}
  if [ "$engine" = "podman" ]; then
    if ! command -v podman >/dev/null 2>&1; then
      echo "Podman not found. Install Podman (https://podman.io/getting-started/) or run with CONTAINER_ENGINE=docker." >&2
      exit 3
    fi
    # Detect if podman compose is configured to use an external provider (docker-compose)
    PC_OUT=$(podman compose version 2>&1 || true)
    if echo "$PC_OUT" | grep -q "Executing external compose provider"; then
      echo "Detected podman compose is configured to use an external compose provider (e.g. docker-compose)." >&2
      echo "This configuration can cause interactive prompts or repeated warnings which may block automation." >&2
      echo "Recommendation: use native 'podman compose' (libpod provider), install podman-compose shim, or use Docker (CONTAINER_ENGINE=docker)." >&2
      echo "If you intentionally use an external provider, re-run with CONTAINER_ENGINE=docker or adjust your podman configuration." >&2
      exit 3
    fi
    if ! command -v podman-compose >/dev/null 2>&1; then
      echo "podman-compose not found. Install podman-compose (e.g. 'sudo apt install podman-compose') or switch to Docker." >&2
      exit 3
    fi
  else
    if ! command -v docker >/dev/null 2>&1; then
      echo "Docker not found. Install Docker (https://docs.docker.com/get-docker/) or run with CONTAINER_ENGINE=podman." >&2
      exit 3
    fi
    if ! docker compose version >/dev/null 2>&1; then
      echo "Docker Compose plugin not available. Ensure you have 'docker compose' (Docker Desktop or plugin)." >&2
      exit 3
    fi
  fi
}

# Small helper for colored output (when supported)
function _color() {
  local code="$1"; shift
  if [ -t 1 ]; then
    printf "\e[%sm%s\e[0m" "$code" "$*"
  else
    printf "%s" "$*"
  fi
}
function info() { _color "1;34" "[INFO] $*\n"; }
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

function wait_for_health() {
  local url=${1:-http://localhost:8080/health}
  echo "Waiting for health at $url (timeout ${TIMEOUT}s) ..."
  local tries=0
  local max=$((TIMEOUT / 2))
  until curl -fsS "$url" >/dev/null 2>&1; do
    tries=$((tries+1))
    if [ $tries -ge $max ]; then
      echo "Timed out waiting for $url" >&2
      return 2
    fi
    sleep 2
  done
  echo "Service healthy: $url"
}

function run_tests() {
  echo "Running backend tests inside a container (compose profile: $TEST_PROFILE)"
  if [ -n "$PROFILES" ]; then
    run_compose --profile $TEST_PROFILE up --abort-on-container-exit --exit-code-from tests
  else
    run_compose --profile $TEST_PROFILE up --abort-on-container-exit --exit-code-from tests
  fi
  local exit_code=$?
  echo "Backend tests container exited with $exit_code"
  return $exit_code
}

function run_dashboard_tests_locally() {
  echo "Running dashboard tests from host (requires Bun)"
  (cd dashboard && bun test)
}

function cleanup_containers() {
  echo "Tearing down compose environment and removing images..."
  if [ "$ENGINE" = "podman" ]; then
    podman-compose -f "$COMPOSE_FILE" down -v --remove-orphans || true
    # Remove built images under the compose project name
    podman-compose -f "$COMPOSE_FILE" rm -f || true
    # Optionally prune dangling images/volumes left behind
    if [ "$PRUNE_DANGLING" -eq 1 ]; then
      info "Pruning dangling podman images & volumes (PRUNE_DANGLING=1)"
      podman image prune -a -f || true
      podman volume prune -f || true
    fi
  else
    docker compose -f "$COMPOSE_FILE" down -v --remove-orphans --rmi all || true
    if [ "$PRUNE_DANGLING" -eq 1 ]; then
      info "Pruning dangling docker images & volumes (PRUNE_DANGLING=1)"
      docker image prune -f || true
      docker volume prune -f || true
      docker builder prune -f || true
    fi
  fi
}

function show_results() {
  echo "Collecting logs and results"
  echo "OpenMemory Backend Logs (last 200 lines):"
  if [ "$ENGINE" = "podman" ]; then
    podman logs --tail 200 "${PWD##*/}_openmemory_1" || true
  else
    docker compose -f "$COMPOSE_FILE" logs --tail 200 openmemory || true
  fi
}

# Run: build and start services
if [ "$PULL_IMAGES" -eq 1 ]; then
  echo "Pulling latest images before building (PULL_IMAGES=1)"
  run_compose pull || true
fi

# If requested, rebuild local images (defaults to forced rebuild with no cache)
if [ "$FORCE_REBUILD" -eq 1 ]; then
  info "FORCE_REBUILD=1 - rebuilding local images from source"
  if [ "$ENGINE" = "podman" ]; then
    if [ "$NO_CACHE" -eq 1 ]; then
      podman-compose -f "$COMPOSE_FILE" build --no-cache || true
    else
      podman-compose -f "$COMPOSE_FILE" build || true
    fi
  else
    if [ "$NO_CACHE" -eq 1 ]; then
      docker compose -f "$COMPOSE_FILE" build --no-cache || true
    else
      docker compose -f "$COMPOSE_FILE" build || true
    fi
  fi
fi

if [ "$INCLUDE_OLLAMA" -eq 1 ]; then
  if ! echo "$PROFILES" | grep -q "ollama"; then
    PROFILES="${PROFILES} ollama"
  fi
fi

if [[ "$PROFILES" =~ "ollama" ]]; then
  echo "Configuring backend to use Ollama for embeddings (exporting env to compose)"
  export OM_EMBEDDINGS=ollama
  export OM_EMBED_KIND=ollama
  export OM_OLLAMA_MODELS=${EMBEDDING_MODEL}
  export OM_OLLAMA_MGMT_E2E=1
fi

if [ -n "$PROFILES" ]; then
  echo "Starting compose with profiles: $PROFILES"
  run_compose --profile "$PROFILES" up --build --force-recreate -d
else
  run_compose up --build --force-recreate -d
fi

# Export environment variables to configure backend to use Ollama for embeddings
if [[ "$PROFILES" =~ "ollama" ]]; then
  echo "Configuring backend to use Ollama for embeddings (exporting env to compose)"
  export OM_EMBEDDINGS=ollama
  export OM_EMBED_KIND=ollama
  export OM_OLLAMA_MODELS=${EMBEDDING_MODEL}
  # This environment variable will enable management tests for Ollama in the backend test suite
  export OM_OLLAMA_MGMT_E2E=1
fi

echo "Waiting for backend to be healthy..."
if ! wait_for_health "http://localhost:8080/health"; then
  echo "Backend health check failed" >&2
  show_results
  cleanup_containers
  exit 2
fi

# If Ollama sidecar is available, pull the embedding model required for tests and wait until it's loaded
function pull_and_wait_embedding_model() {
  local model=${1:-$EMBEDDING_MODEL}
  local wait_seconds=${2:-$EMBEDDING_MODEL_WAIT_SECONDS}

  info "Checking Ollama status and preparing embedding model: $model"
  # Check status
  local s=$(curl -fsS -m 5 -sS http://localhost:8080/embed/ollama/status || true)
  if [ -z "$s" ]; then
    warn "Ollama status endpoint not reachable. Skipping model pull."
    return 0
  fi

  # Pull model via backend API
  info "Requesting pull for model: $model"

  # If interactive, confirm pull because model downloads can be large
  if [ "${INTERACTIVE:-0}" = "1" ]; then
    if ! prompt_yes_no "Will pull model '$model' into Ollama (may download large files). Proceed?"; then
      warn "User declined model pull. Skipping."; return 0;
    fi
  fi

  curl -fsS -X POST http://localhost:8080/embed/ollama/pull -H 'Content-Type: application/json' -d "{ \"model\": \"${model}\" }" || true

  # Poll list to ensure model appears with tiered/adaptive retry and optional progress logs
  local elapsed=0
  local attempt=0

  # Tiers: aggressive short attempts -> moderate backoff -> long backoff
  local tier1_seconds=30   # frequent quick polls every 2s
  local tier1_interval=2
  local tier2_seconds=90   # medium polls with small backoff
  local tier2_interval=6
  local tier3_interval=20  # long poll interval

  local total_wait=${wait_seconds}

  while [ $elapsed -lt $total_wait ]; do
    attempt=$((attempt+1))

    # Check current list/status for progress information
    local models_json=$(curl -fsS http://localhost:8080/embed/ollama/list || true)
    if echo "$models_json" | grep -q "${model}"; then
      ok "Model ${model} is available"
      return 0
    fi

    # Get status JSON for optional progress insight; don't fail if unavailable
    local status_json=$(curl -fsS -m 3 http://localhost:8080/embed/ollama/status || true)
    if [ -n "$status_json" ]; then
      # If backend exposes a 'downloads' or 'progress' key we can print brief info
      # Print raw status when E2E_VERBOSE=1 or SHOW_OLLAMA_LOGS is enabled
      if [ "$E2E_VERBOSE" -eq 1 ] || [ "$SHOW_OLLAMA_LOGS" -eq 1 ]; then
        info "Ollama status: $status_json"
      fi
      # Parse progress indicators if present (percent, downloaded/total bytes)
      # Try to extract a percentage token if any
      local percent
      percent=$(echo "$status_json" | awk -F '[:,]' '{ for(i=1;i<=NF;i++){ if(tolower($i) ~ /percent|percentage/){ gsub(/[^0-9.]/, "", $(i+1)); print $(i+1); exit } } }') || true

      # Try to extract downloaded_bytes and total_bytes if available
      local downloaded_bytes
      local total_bytes
      downloaded_bytes=$(echo "$status_json" | awk -F '[:,]' '{ for(i=1;i<=NF;i++){ if(tolower($i) ~ /downloaded[_ ]?bytes|downloaded/){ gsub(/[^0-9]/, "", $(i+1)); print $(i+1); exit } } }') || true
      total_bytes=$(echo "$status_json" | awk -F '[:,]' '{ for(i=1;i<=NF;i++){ if(tolower($i) ~ /total[_ ]?bytes|total[_ ]?size/){ gsub(/[^0-9]/, "", $(i+1)); print $(i+1); exit } } }') || true

      # If we found a percent token, show it; otherwise if we have bytes, compute percentage
      if [ -n "$percent" ]; then
        # Normalize (remove trailing .0)
        local pct_print
        pct_print=$(echo "$percent" | awk '{printf "%g", $0}') || pct_print="$percent"
        if [ "$E2E_VERBOSE" -eq 1 ] || [ "$SHOW_OLLAMA_LOGS" -eq 1 ]; then
          info "Download progress: ${pct_print}%"
        fi
      elif [ -n "$downloaded_bytes" ] && [ -n "$total_bytes" ] && [ "$total_bytes" -gt 0 ]; then
        # compute percent and format human readable
        local pct_bytes
        pct_bytes=$(awk "BEGIN {printf \"%.0f\", (${downloaded_bytes}*100)/${total_bytes}}") || pct_bytes="?"
        # humanize bytes into KB/MB
        humanize_bytes() { awk -v b="$1" 'BEGIN{ if(b>=1073741824)printf "%.1fGB",b/1073741824; else if(b>=1048576)printf "%.1fMB",b/1048576; else if(b>=1024)printf "%.1fKB",b/1024; else printf "%dB",b }' ; }
        local d_human
        local t_human
        d_human=$(humanize_bytes "$downloaded_bytes") || d_human="${downloaded_bytes}B"
        t_human=$(humanize_bytes "$total_bytes") || t_human="${total_bytes}B"
        if [ "$E2E_VERBOSE" -eq 1 ] || [ "$SHOW_OLLAMA_LOGS" -eq 1 ]; then
          info "Download progress: ${pct_bytes}% (${d_human} / ${t_human})"
        fi
      fi

      # If any common 'progress' indicators are present, extend timeout conservatively
      if echo "$status_json" | grep -q -i "progress\|downloading\|percentage\|percent"; then
        # Add a conservative extension (not more than 2x original wait)
        local extra=30
        if [ $((total_wait + extra)) -le $(( wait_seconds * 2 )) ]; then
          total_wait=$(( total_wait + extra ))
          info "Detected download activity; extending wait window by ${extra}s (new total ${total_wait}s)"
        fi
      fi
    fi

    # Show periodic container logs for debugging when requested
    if [ "$SHOW_OLLAMA_LOGS" -eq 1 ] && [ $((attempt % 3)) -eq 0 ]; then
      echo "--- Ollama logs (tail 30) ---"
      if [ "$ENGINE" = "podman" ]; then
        podman logs --tail 30 "${PWD##*/}_ollama_1" || true
      else
        docker compose -f "$COMPOSE_FILE" logs --tail 30 ollama || true
      fi
      echo "--- end logs ---"
    fi

    # Decide sleep interval by phase
    local sleep_s=$tier3_interval
    if [ $elapsed -lt $tier1_seconds ]; then
      sleep_s=$tier1_interval
    elif [ $elapsed -lt $((tier1_seconds + tier2_seconds)) ]; then
      # Gentle exponential-ish increase inside tier 2
      sleep_s=$tier2_interval
    fi

    # add jitter to avoid thundering herd (0..3s)
    local jitter=$((RANDOM % 4))
    sleep_s=$(( sleep_s + jitter ))

    info "Attempt ${attempt}: model not yet available. Sleeping ${sleep_s}s (elapsed ${elapsed}s / total ${total_wait}s)"
    sleep "$sleep_s"
    elapsed=$((elapsed + sleep_s))
  done

  fatal "Timed out waiting for model ${model} to be available after ${wait_seconds}s"
  return 2
}

pull_and_wait_embedding_model "$EMBEDDING_MODEL" || true

# If critical-only, do minimal checks and exit early
if [ "$CRITICAL_ONLY" -eq 1 ]; then
  echo "Running CRITICAL-ONLY E2E smoke tests"
  # Ensure Ollama is present
  echo "Checking Ollama list for ${EMBEDDING_MODEL}"
  LIST=$(curl -fsS http://localhost:8080/embed/ollama/list || true)
  if echo "$LIST" | grep -q "$EMBEDDING_MODEL"; then
    echo "Embedding model found: $EMBEDDING_MODEL"
    exit 0
  else
    echo "Embedding model $EMBEDDING_MODEL not found - smoke test failed" >&2
    echo "Response: $LIST"
    exit 2
  fi
fi

# Optionally run the internal tests service
TEST_RESULT=0
if run_tests; then
  echo "Backend tests succeeded"
  TEST_RESULT=0
else
  echo "Backend tests failed"
  TEST_RESULT=1
fi

# Run dashboard tests locally against running backend
echo "Running dashboard tests (host)"
if run_dashboard_tests_locally; then
  echo "Dashboard tests succeeded"
else
  echo "Dashboard tests failed"
  TEST_RESULT=1
fi

show_results

if [ "$KEEP_CONTAINERS" -eq 0 ]; then
  if [ "${INTERACTIVE:-0}" = "1" ]; then
    if prompt_yes_no "Cleanup containers and remove images now?"; then
      cleanup_containers
    else
      echo "Skipping cleanup as requested by user";
    fi
  else
    cleanup_containers
  fi
else
  echo "KEEP_CONTAINERS set; not removing compose artifacts" 
fi

if [ $TEST_RESULT -eq 0 ]; then
  echo "E2E containerized tests passed"
else
  echo "E2E containerized tests failed"
fi

exit $TEST_RESULT
