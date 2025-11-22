#!/usr/bin/env bash
set -euo pipefail

# Shared helpers for container tooling detection & fallback
# Sourced by e2e-containers.sh and pre-push-checks.sh

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "$(pwd)")

function _ct_info(){ printf "[CT-INFO] %s\n" "$*"; }
function _ct_warn(){ printf "[CT-WARN] %s\n" "$*" >&2; }
function _ct_fatal(){ printf "[CT-ERROR] %s\n" "$*" >&2; exit 3; }

function detect_external_podman_provider() {
  # Return 0 if external provider is detected
  if command -v podman >/dev/null 2>&1; then
    PC_OUT=$(podman compose version 2>&1 || true)
    if echo "$PC_OUT" | grep -q "Executing external compose provider"; then
      return 0
    fi
  fi
  return 1
}

function verify_container_tooling() {
  local engine=${CONTAINER_ENGINE:-docker}
  if [ "$engine" = "podman" ]; then
    if ! command -v podman >/dev/null 2>&1; then
      _ct_fatal "Podman not found. Install Podman (https://podman.io/getting-started/) or set CONTAINER_ENGINE=docker."
    fi
    # detect external provider
    if detect_external_podman_provider; then
      _ct_warn "Detected podman compose configured to use external provider (may block automation)."
      return 10
    fi
    if ! command -v podman-compose >/dev/null 2>&1; then
      _ct_warn "podman-compose shim not found. Consider installing the shim or use Docker via CONTAINER_ENGINE=docker."
      # shim missing is a warning only; user may rely on native compose
    fi
  else
    if ! command -v docker >/dev/null 2>&1; then
      _ct_fatal "Docker not found. Install Docker (https://docs.docker.com/get-docker/) or set CONTAINER_ENGINE=podman."
    fi
    if ! docker compose version >/dev/null 2>&1; then
      _ct_fatal "Docker Compose plugin not available. Ensure 'docker compose' is installed (Docker Desktop / plugin)."
    fi
  fi
  return 0
}

function attempt_ollama_fallback() {
  # Try a lightweight container run of Ollama for environments where compose fails
  local engine=${CONTAINER_ENGINE:-docker}
  local OLLAMA_IMAGE=${OLLAMA_IMAGE:-docker.io/ollama/ollama:0.3.0}
  local OLLAMA_NAME=${OLLAMA_NAME:-openmemory_fallback_ollama}
  local OLLAMA_PORT=${OLLAMA_PORT:-11434}
  local caps_mem=${FALLBACK_OLLAMA_MEM:-512m}
  local caps_cpus=${FALLBACK_OLLAMA_CPUS:-0.5}

  _ct_info "Attempting lightweight Ollama fallback (engine=${engine})"
  if [ "$engine" = "podman" ]; then
    if ! command -v podman >/dev/null 2>&1; then
      _ct_warn "podman missing; cannot run Ollama fallback"
      return 2
    fi
    podman rm -f "$OLLAMA_NAME" >/dev/null 2>&1 || true
    podman run -d --name "$OLLAMA_NAME" --memory=${caps_mem} --cpus=${caps_cpus} -p ${OLLAMA_PORT}:${OLLAMA_PORT} --pids-limit=50 "$OLLAMA_IMAGE" || return 2
  else
    if ! command -v docker >/dev/null 2>&1; then
      _ct_warn "docker missing; cannot run Ollama fallback"
      return 2
    fi
    docker rm -f "$OLLAMA_NAME" >/dev/null 2>&1 || true
    docker run -d --name "$OLLAMA_NAME" --memory=${caps_mem} --cpus=${caps_cpus} -p ${OLLAMA_PORT}:${OLLAMA_PORT} --pids-limit=50 "$OLLAMA_IMAGE" || return 2
  fi

  # Wait briefly for health
  for i in $(seq 1 8); do
    if curl -fsS http://localhost:${OLLAMA_PORT}/api/health >/dev/null 2>&1; then
      _ct_info "Fallback Ollama is up at http://localhost:${OLLAMA_PORT}"
      return 0
    fi
    sleep 1
  done
  _ct_warn "Fallback Ollama run started but did not respond to health checks yet. Check logs."
  return 1
}

function suggest_install_instructions() {
  # Detect OS and print package manager commands to install docker/podman and podman-compose
  local osname="unknown"
  if [ -r /etc/os-release ]; then
    osname=$(awk -F= '/^ID=/{print $2}' /etc/os-release | tr -d '"')
  fi
  _ct_info "Detected OS: ${osname}";
  case "$osname" in
    ubuntu|debian)
      cat <<'EOF'
Suggested commands (Debian/Ubuntu):
  # Install Docker (recommended)
  sudo apt update && sudo apt install -y ca-certificates curl gnupg lsb-release
  sudo mkdir -p /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

  # Or install Podman (rootless friendly)
  sudo apt install -y podman podman-compose
EOF
      ;;
    fedora|rhel|centos)
      cat <<'EOF'
Suggested commands (Fedora/RHEL/CentOS):
  # Docker (subscribe to repositories as needed) or use Podman
  sudo dnf install -y podman podman-compose
  # For Docker on RHEL-based distros use Docker's official docs
EOF
      ;;
    arch)
      cat <<'EOF'
Suggested commands (Arch):
  sudo pacman -Syu docker docker-compose podman podman-compose
EOF
      ;;
    macos|darwin)
      cat <<'EOF'
Suggested commands (macOS):
  # Use Homebrew
  brew install --cask docker
  # For Podman
  brew install podman podman-compose
EOF
      ;;
    *)
      _ct_info "No tailored instructions available for ${osname}. Check https://docs.docker.com/get-docker/ or https://podman.io/getting-started"
      ;;
  esac
}

export -f detect_external_podman_provider attempt_ollama_fallback verify_container_tooling suggest_install_instructions
