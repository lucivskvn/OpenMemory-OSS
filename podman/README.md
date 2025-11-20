# Podman / systemd Quadlet examples

This folder contains example quadlet and podman notes to run OpenMemory under Podman + systemd.

Notes:

- When mounting host directories into containers on SELinux-enabled systems, use the `:Z` option on volumes to apply a shared label, e.g.

  volumes:
  - ./data:/app/data:Z

- These quadlets are examples only. Validate and adapt to your environment before use.

## Linux Mint 22 / Ubuntu 24.04 Installation

For Linux Mint 22 (Ubuntu 24.04 base) users, install Podman and related tools:

```bash
sudo apt update && sudo apt install -y podman podman-compose podman-docker
podman --version
podman run --rm -it docker.io/library/alpine:3.16 uname -a
```

This contains the builds from Ubuntu and automatically inherits Mint's package updates. See `docs/deployment/linux-mint-22-setup.md` for Podman rootless setup, GPU passthrough, and other system dependencies.

## Additional guidance

Quickstart (systemd + Podman quadlets):

1. Ensure Podman and podman-quadlets are installed on your host.

2. Create the data directory and set proper permissions.

For rootless Podman (recommended):

```bash
mkdir -p ~/.local/share/openmemory
chown $USER:$USER ~/.local/share/openmemory
```

For rootful (system) deployments only:

```bash
sudo mkdir -p /var/lib/openmemory
sudo chown $USER:$USER /var/lib/openmemory
```

## Ollama Sidecar (Podman)

If you plan to run Ollama as a sidecar with Podman, create a dedicated volume for Ollama models and ensure it is owned by your user (rootless):

```bash
podman volume create ollama_models --driver local --opt o=uid=$(id -u),gid=$(id -g)
podman volume create openmemory_data --driver local --opt o=uid=$(id -u),gid=$(id -g)
```

For convenience there is a script `scripts/podman-up-ollama.sh` that will create the required volumes
and bring up Ollama using `podman compose` (or the `podman-compose` fallback). It also performs
a minimal health check and prints the container logs on failure. The script's `--skip-pull` option
now applies to both the `podman compose` and `podman-compose` flows (it sets `OM_OLLAMA_MODELS` to
the empty value for the duration of the compose command), or when falling back to `podman run` it
explicitly unsets the variable inside the container. This keeps development runs lightweight and
prevents automatic large model downloads while iterating.

If you have limited memory or are seeing Podman hangs, use the safe stub mode:

```bash
# Start lightweight Ollama stub (safe mode) to avoid crashes
OM_OLLAMA_SAFE=1 ./scripts/podman-up-ollama.sh
```

The `OM_OLLAMA_SAFE` mode builds a tiny `ollama-stub` image and runs it with strict
resource limits (512MB, 0.5 CPU). This provides a minimal REST surface that responds to
the same health and model-list endpoints used by the backend tests and avoids heavy memory
consumption from the full Ollama image.

### Memory notes & external compose provider

- If you're seeing excessive memory usage while creating the Ollama volume or starting
  the Ollama service, it is likely due to the full Ollama image pulling and loading
  models (these can be large). Be cautious with the environment variable
  `OM_OLLAMA_MODELS` — it is commonly set to `nomic-embed-text` and will cause the sidecar
  to auto-download large models when it starts. To prevent automatic model download
  in development, run the sidecar with an empty `OM_OLLAMA_MODELS` value or use
  `OM_OLLAMA_SAFE=1` to run the lightweight stub instead.

- `podman compose` can be configured to run an *external* compose provider (e.g.,
  the Docker Compose shim). The CLI prints a message like:

  "Executing external compose provider '/home/user/.local/bin/docker-compose'"

  This is informational but may cause repeated logs if `podman compose` invokes a
  wrapper; the script `scripts/podman-up-ollama.sh` now detects that situation and
  falls back to a controlled `podman run` with resource caps to avoid thrashing.

  If you want to use the native podman compose implementation instead, remove the
  `docker-compose` shim from PATH or install the `podman` compose plugin from your
  distribution packages.

If you need to wait for Ollama to be fully ready before running tests, use:

```bash
./scripts/wait-for-ollama.sh 60  # wait up to 60 seconds
```

Start OpenMemory and the Ollama sidecar together using `podman-compose` or `podman play kube` after converting the `docker-compose.yml`. The `ollama_models` volume will persist downloaded model files.

Pull models into the sidecar via the backend management endpoint after services are running:

```bash
curl -X POST http://localhost:8080/embed/ollama/pull -H "Content-Type: application/json" -d '{"model":"nomic-embed-text"}'
```

### Using OLM and --skip-pull together

Use the `--olm` flag to reduce the resource limits on the Ollama container and
`--skip-pull` to prevent automatic model downloads when starting locally:

```bash
./scripts/podman-up-ollama.sh --olm --skip-pull
```

This helps keep the sidecar light for low-capacity development machines and avoids
the heavy model downloads that can consume memory and disk.

### Options for safer dev runs

- Start the sidecar without automatically pulling models:

  ```bash
  ./scripts/podman-up-ollama.sh --skip-pull
  ```

  This unsets `OM_OLLAMA_MODELS` inside the container for the duration of the run, preventing the sidecar from immediately downloading large models.

- Opt-in low-memory mode (OLM) for local development on low-RAM systems:

  ```bash
  ./scripts/podman-up-ollama.sh --olm
  ```

  This runs the Ollama container with smaller limits: 512MB memory and 0.5 CPUs. Use together with `--skip-pull` when testing on small machines.

### Additional logs and visibility

- The script now reports the compose method being used: `podman compose` (native), `podman-compose` (shim), or a fallback `podman run`. If an external provider is detected, the script prints a warning and falls back to `podman run` so resource caps can be applied deterministically.

1. Build the image locally or pull from registry:

```bash
cd backend
podman build -t ghcr.io/lucivskvn/openmemory-OSS:latest .
# or pull the published image
podman pull ghcr.io/lucivskvn/openmemory-OSS:latest

## GPU Passthrough Examples

For local development with GPUs, follow the steps below depending on your GPU vendor.

### NVIDIA (RTX 3050 Mobile)

1. Install drivers and NVIDIA Container Toolkit:

Note: On Ubuntu 24.04 / Linux Mint 22, `nvidia-container-toolkit` and `nvidia-ctk` packages may require enabling the official NVIDIA container toolkit repository first. Follow NVIDIA's installation guide (https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) or run the repository setup script involving `curl | gpg` and adding the repo to `sources.list.d` before running `apt install`.

Driver minor versions may change based on distro packaging, but this guide assumes the 580 series for CUDA 12.4+ support. See `docs/deployment/gpu-optimization.md` for detailed GPU tuning recommendations and troubleshooting.

```bash
sudo apt install -y nvidia-driver-580 nvidia-utils-580 nvidia-ctk nvidia-container-toolkit
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
```

2. Run container with CDI GPU devices:

```bash
podman run --rm --device nvidia.com/gpu=all --security-opt label=disable ghcr.io/lucivskvn/openmemory-OSS:latest nvidia-smi
```

### AMD (Radeon 660M / Vulkan)

1. Install Vulkan drivers and tools:

```bash
sudo apt install -y mesa-vulkan-drivers vulkan-tools
sudo usermod -aG render,video $(whoami)
```

2. Run container with DRI devices for Vulkan:

```bash
podman run --rm --device /dev/dri --device /dev/kfd -v /usr/share/vulkan/icd.d:/usr/share/vulkan/icd.d:ro ghcr.io/lucivskvn/openmemory-OSS:latest vulkaninfo | head
```

See `docs/deployment/gpu-optimization.md` for tuning Ollama and additional GPU options.
```

1. Use the example quadlets or `podman run` for an ephemeral test (rootless example shown):

```bash
# rootless quick test (binds a user-owned host path into /data)
podman run --userns=keep-id -p 8080:8080 -v $HOME/.local/share/openmemory:/data:Z ghcr.io/lucivskvn/openmemory-OSS:latest
```

Notes:

- For SELinux-enabled hosts, append `:Z` to volume mounts.
- If you prefer docker-compose style flows, use `podman-compose` or `podman play kube`.

Additional rootless/systemd tips:

- For rootless Podman + systemd setups, enable user namespace remapping by adding `UserNS=keep-id` to the quadlet/unit. This keeps file ownership sensible for the running user.
- For rootless Podman + systemd setups, enable user namespace remapping by adding `UserNS=keep-id` to the quadlet/unit. This keeps file ownership sensible for the running user.
- Note: the container image runs its process as a non-root user with UID/GID `1001` inside the container. That internal UID is independent from your host user; `UserNS=keep-id` ensures host UID/GID map correctly into the container so mounted volumes retain expected ownership.
- Prefer a per-user environment file instead of a system-wide file to avoid leaking secrets between accounts. The recommended path is `%h/.config/openmemory/openmemory.env` (systemd expands `%h` to the user's home).

Step-by-step (user-level systemd + podman quadlets)

1. Install Podman and quadlets support on your host (distribution packages / `podman-quadlets`).

2. Prepare directories and enable lingering so the service can run after logout:

```bash
# create data and config directories
mkdir -p ~/.config/openmemory
mkdir -p ~/.local/share/containers/storage

# enable linger so systemd user units can run after logout
loginctl enable-linger $USER
```

1. Populate a user-scoped env file from the example and secure it:

```bash
cp .env.example ~/.config/openmemory/openmemory.env
chmod 600 ~/.config/openmemory/openmemory.env
# Edit the file and fill in OM_* values (do not commit or share this file)
${EDITOR:-nano} ~/.config/openmemory/openmemory.env
```

1. Install the quadlets (copy the `.container` and `.volume` files into `~/.config/containers/` or use `podman generate systemd` as a template):

```bash
# Podman 5.x+: preferred user location for quadlets
mkdir -p ~/.config/containers/systemd/
cp podman/openmemory.container ~/.config/containers/systemd/
cp podman/openmemory-data.volume ~/.config/containers/systemd/

# Legacy distros may still use ~/.config/systemd/user/containers/ — create a
# symlink if needed per Podman docs:
# ln -s ~/.config/containers/systemd ~/.config/systemd/user/containers

# reload user units and start
systemctl --user daemon-reload
systemctl --user start openmemory
```

1. Verify service health and logs:

```bash
systemctl --user status openmemory
journalctl --user -u openmemory -f
# check HTTP health endpoint
curl -f http://localhost:8080/health
```

Troubleshooting

- Permission denied on /data writes: Ensure you used `:Z` on the mount and that the host directory ownership maps correctly to your user namespace. Check `/etc/subuid` and `/etc/subgid` exist and include your user.
- Service fails immediately / cannot pull image: increase `TimeoutStartSec` or pre-pull the image with `podman pull` to avoid initial network/pull delays.
- Health check failing: inspect container logs with `podman logs <container>` or `journalctl --user -u openmemory` for fetch errors.
- Subuid/Subgid missing: add an entry for your user in `/etc/subuid` and `/etc/subgid` or install the distro package that configures them for you.

Testing locally with podman run

```bash
podman run --rm --name openmemory -p 8080:8080 -v /var/lib/openmemory:/data:Z docker.io/yourrepo/openmemory:latest
# then in another shell
curl -f http://localhost:8080/health
```

Integration notes

- The quadlet/volume files use `:Z` relabeling for SELinux hosts and `UserNS=keep-id` for rootless UID mapping.
- The Docker-compose setup remains suitable for local multi-container development. For production, use podman quadlets or a Kubernetes manifest generated with `podman play kube`.

If you'd like, I can generate a `kube` YAML manifest from `docker-compose.yml` for `podman play kube`.
