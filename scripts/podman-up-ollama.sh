#!/usr/bin/env bash
set -euo pipefail

# Helper: bring up Ollama with Podman (rootless-friendly)
# Creates user-owned volumes and attempts to start the Ollama service.
# Usage: ./scripts/podman-up-ollama.sh

ROOT="$(cd "$(dirname "$0")/.." >/dev/null && pwd)"

echo "Checking podman and podman-compose compatibility..."
if command -v podman >/dev/null 2>&1; then
  echo "podman found: $(podman --version)"
else
  echo "podman not found on PATH" >&2
  exit 1
fi

# CLI options: --skip-pull prevents automatic Ollama model downloads; --olm opts into low-memory caps
SKIP_PULL=0
OLM=0
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --skip-pull)
      SKIP_PULL=1
      shift
      ;;
    --olm)
      OLM=1
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--skip-pull] [--olm]"
      echo "  --skip-pull  : Prevent the Ollama sidecar from auto-pulling large models when started"
      echo "  --olm        : OLM mode — opt-in low-memory caps for Ollama (512MB, 0.5 CPU)"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

COMPOSE_METHOD="unknown"

# Volume names from docker-compose.yml
OLLAMA_VOL=ollama_models
OPENMEM_VOL=openmemory_data

# Create volumes with user-owned options for rootless environments
echo "Creating Podman volumes for rootless usage if missing..."
if ! podman volume inspect "$OLLAMA_VOL" >/dev/null 2>&1; then
  podman volume create "$OLLAMA_VOL" --driver local --opt o=uid=$(id -u),gid=$(id -g)
fi
if ! podman volume inspect "$OPENMEM_VOL" >/dev/null 2>&1; then
  podman volume create "$OPENMEM_VOL" --driver local --opt o=uid=$(id -u),gid=$(id -g)
fi

# Try to start via podman compose
if podman compose version >/dev/null 2>&1; then
  echo "Using 'podman compose' to start ollama..."
  COMPOSE_METHOD="podman-compose-native"
  # Detect if Podman is configured to use an *external* compose provider
  # such as `docker-compose` (often installed at ~/.local/bin/docker-compose).
  # External compose providers can produce repeated logging and behave
  # differently than libpod's native compose implementation. If we detect
  # an external provider we'll fall back to a safer `podman run` command
  # which lets us set resource caps explicitly and avoid the provider
  # invoking heavy container startup semantics.
  PC_OUT=$(podman compose version 2>&1 || true)
  if echo "$PC_OUT" | grep -q "Executing external compose provider"; then
    echo "Detected external compose provider used by 'podman compose'." >&2
    echo "This may cause repeated logs and/or resource-heavy behavior." >&2
    echo "Falling back to a controlled podman run with resource limits." >&2
    FAILED_COMPOSE=true
    COMPOSE_METHOD="external-provider"
  fi
  # If podman compose wraps docker-compose as an external provider it can fail.
  # Capture output and detect that scenario, falling back to a direct podman run.
  # When skipping pull, run compose with the OM_OLLAMA_MODELS env unset to avoid
  # triggering automatic model downloads. Use `env` to set it only for the compose
  # invocation so we do not modify the user's environment permanently.
  if [[ ${SKIP_PULL:-0} -eq 1 ]]; then
    echo "--skip-pull: starting podman compose with OM_OLLAMA_MODELS unset"
    COMPOSE_CMD="env OM_OLLAMA_MODELS= podman compose -f \"$ROOT/docker-compose.yml\" up -d ollama"
  else
    COMPOSE_CMD="podman compose -f \"$ROOT/docker-compose.yml\" up -d ollama"
  fi

  if eval "$COMPOSE_CMD" 2>&1 | tee /tmp/podman-compose-ollama.log; then
    echo "podman compose started ollama (compose method: ${COMPOSE_METHOD})"
  else
    echo "podman compose failed, will attempt direct 'podman run' fallback"
    cat /tmp/podman-compose-ollama.log
    FAILED_COMPOSE=true
  fi
else
  # Fallback to podman-compose if present
  if command -v podman-compose >/dev/null 2>&1; then
    echo "Using 'podman-compose' to start ollama..."
    COMPOSE_METHOD="podman-compose-shim"
    if [[ ${SKIP_PULL:-0} -eq 1 ]]; then
      echo "--skip-pull: starting podman-compose shim with OM_OLLAMA_MODELS unset"
      env OM_OLLAMA_MODELS= podman-compose -f "$ROOT/docker-compose.yml" up -d ollama
    else
      podman-compose -f "$ROOT/docker-compose.yml" up -d ollama
    fi
  else
    echo "No Podman compose found. Try installing podman-compose or use 'podman run' with the suggested params in podman/README.md" >&2
    FAILED_COMPOSE=true
  fi
fi

# give Ollama a few seconds to initialize
sleep 2

# Health check
echo "Checking Ollama health (http://localhost:11434)..."
if curl -fsS http://localhost:11434/api/health >/dev/null 2>&1; then
  echo "Ollama is up at http://localhost:11434"
else
  # If compose failed or Ollama not reachable, try a direct podman run fallback.
  if [[ ${FAILED_COMPOSE:-false} == true ]]; then
    echo "Trying direct 'podman run -d' fallback for Ollama with limited resources..."
    # Use lightweight resources for testing to avoid system OOM/hangs
    # Determine memory caps. OLM opt-in makes testing possible on low-memory hosts.
    if [[ ${OLM:-0} -eq 1 ]]; then
      echo "OLM enabled: opting into low-memory caps for Ollama (512MB, 0.5 CPUs)" >&2
      OLLAMA_MEM="512m"
      OLLAMA_CPUS="0.5"
    else
      OLLAMA_MEM="1024m"
      OLLAMA_CPUS="1.0"
    fi

    # Skip model pull by explicitly unsetting OM_OLLAMA_MODELS in the container's env
    if [[ ${SKIP_PULL:-0} -eq 1 ]]; then
      echo "--skip-pull specified: starting container with no OM_OLLAMA_MODELS (avoids auto-download)" >&2
      SKIP_PULL_ENV="-e OM_OLLAMA_MODELS="
    else
      SKIP_PULL_ENV=""
      if [ -n "${OM_OLLAMA_MODELS:-}" ]; then
        echo "Warning: OM_OLLAMA_MODELS is set — the Ollama container may pull and load large models on startup." >&2
      fi
    fi

    echo "Launching ollama with memory=${OLLAMA_MEM}, cpus=${OLLAMA_CPUS}, skip-pull=${SKIP_PULL}, compose_method=${COMPOSE_METHOD}" >&2
    podman run -d --name ollama --memory=${OLLAMA_MEM} --cpus=${OLLAMA_CPUS} --pids-limit=50 -p 11434:11434 ${SKIP_PULL_ENV} -v "$OLLAMA_VOL":/root/.ollama:Z docker.io/ollama/ollama:0.3.0 || true
    sleep 3
    # Limit the number of health check attempts so script does not hang indefinitely
    MAX_CHECKS=6
    attempt=0
    while [ "$attempt" -lt "$MAX_CHECKS" ]; do
      if curl -fsS http://localhost:11434/api/health >/dev/null 2>&1; then
        echo "Ollama is up at http://localhost:11434"
        HEALTHY=true
        break
      fi
      attempt=$((attempt+1))
      sleep 2
    done
    if [[ "${HEALTHY:-false}" == true ]]; then
      echo "Ollama is up at http://localhost:11434 (podman run fallback)"
      exit 0
    fi
  fi
  echo "Ollama did not respond on http://localhost:11434; following logs for diagnosis:"
  # If safe-mode is enabled, spin up a lightweight stub to avoid OOM/hang
  if [ "${OM_OLLAMA_SAFE:-}" = "1" ]; then
    echo "OM_OLLAMA_SAFE=1 detected — starting minimal Ollama stub to avoid system hang"
    # Build stub if missing
    if ! podman image inspect openmemory/ollama-stub:local >/dev/null 2>&1; then
      podman build -t openmemory/ollama-stub:local "$ROOT/dev/ollama-stub"
    fi
    podman rm -f ollama-stub >/dev/null 2>&1 || true
    podman run -d --name ollama-stub --memory=512m --cpus=0.5 --pids-limit=20 -p 11434:11434 openmemory/ollama-stub:local || true
    sleep 2
    if curl -fsS http://localhost:11434/api/health >/dev/null 2>&1; then
      echo "Ollama stub is up at http://localhost:11434"
      exit 0
    fi
  fi
  podman compose -f "$ROOT/docker-compose.yml" logs --tail 200 ollama || true
  exit 1
fi

echo "Done. If you want to use Quadlet units, see files in podman/ for examples."
