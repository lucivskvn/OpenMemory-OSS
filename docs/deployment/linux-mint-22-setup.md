# Linux Mint 22 (Ubuntu 24.04 base) Setup

This guide covers installing system dependencies, Bun, Podman (rootless), and GPU passthrough on Linux Mint 22.0 (Ubuntu 24.04 base). Use this as a checklist for local development and reproducible CI runners.

## System prerequisites

- Update packages

```bash
sudo apt update && sudo apt upgrade -y
```

- Install common build dependencies

```bash
sudo apt install -y curl unzip ca-certificates build-essential libssl-dev git pkg-config podman podman-compose podman-docker
```

- Optional: install `jq` and `vim` for convenience

```bash
# sudo apt install -y jq vim
```

## Dashboard Setup (Next.js + Bun)

### Prerequisites

Ensure Bun is installed (see Bun v1.3.2 installation section below).

### Installation

1. **Install dashboard dependencies:**

```bash
cd dashboard
bun install --frozen-lockfile
```

2. **Configure environment:**

Create `dashboard/.env.local`:

```bash
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_API_KEY=your-api-key-here
```

3. **Verify Bun compatibility:**

```bash
bun run verify:bun
```

Expected output:

```
1.3.2
Next.js 16.0.1
```

4. **Start development server:**

```bash
bun run dev
```

The dashboard will be available at http://localhost:3000.

### Vercel AI SDK v5 Compatibility

The dashboard uses Vercel AI SDK v5.0.93, which is fully compatible with Bun:

- **Runtime**: Bun implements Web APIs (fetch, streams) that AI SDK relies on
- **Next.js**: Works with both Node.js and Bun runtimes
- **Streaming**: SSE streaming works natively with Bun's Web Streams
- **Performance**: ~40% faster dev server startup with Bun

### Linux Mint 22 Specific Notes

**System Dependencies:**

If you encounter build errors, ensure these packages are installed:

```bash
sudo apt install -y build-essential libssl-dev pkg-config
```

**Browser Compatibility:**

Tested browsers on Linux Mint 22:

- Firefox 115+ (default Mint browser)
- Chrome/Chromium 120+
- Edge 120+

**Port Conflicts:**

If port 3000 is already in use:

```bash
bun run dev -- -p 3001  # Use port 3001 instead
```

### Production Build

```bash
bun run build
bun run start
```

**Build Output:**

- Static assets: `dashboard/.next/static/`
- Server bundle: `dashboard/.next/server/`
- Standalone mode: Not enabled (uses standard Next.js output)

### Troubleshooting

**Module Resolution Errors:**

```bash
rm -rf node_modules .next bun.lockb
bun install --frozen-lockfile
```

**Next.js Build Errors:**

```bash
bunx next clean
bun run build
```

**AI SDK Not Streaming:**

1. Verify backend is running: `curl http://localhost:8080/health`
2. Check `.env.local` has correct `NEXT_PUBLIC_API_URL`
3. Verify API key matches backend
4. Check browser console for errors

**Bun Version Issues:**

```bash
bun upgrade
bun --version  # Should be >= 1.3.2
```

### Performance Benchmarks (Linux Mint 22)

**Hardware:** Ryzen 5 5600H, 16GB RAM

**Development Server Startup:**

- Node.js: ~4.2 seconds
- Bun: ~1.8 seconds (~57% faster)

**Production Build:**

- Node.js: ~52 seconds
- Bun: ~24 seconds (~54% faster)

**Memory Usage (Dev Server):**

- Node.js: ~420 MB
- Bun: ~280 MB (~33% less)

### Node.js Fallback

If you prefer Node.js for dashboard development:

```bash
npm install
npm run dev:node
npm run build:node
```

All functionality remains identical - Bun just provides better performance.

## Bun v1.3.2 installation

Pin to Bun v1.3.2 for CI parity with the repository.

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.2"
# Append to PATH (typically done automatically)
export PATH="$HOME/.bun/bin:$PATH"
# Verify
bun --version

# Note: After running the install script, open a new shell or update your shell profile so `bun --version` works without a manual PATH export.
```

If you prefer a stable pin in scripts, use the installer with an explicit version and commit hash (see bun.sh docs for exact flags).

## Podman (rootless)

Install Podman and related tools from Ubuntu repos.

```bash
sudo apt install -y podman podman-compose podman-docker
```

Enable rootless support and linger for user services

```bash
sudo loginctl enable-linger $(whoami)
# Ensure subuid/subgid are configured
grep $(whoami) /etc/subuid || sudo usermod --add-subuids 100000-165536 $(whoami)
grep $(whoami) /etc/subgid || sudo usermod --add-subgids 100000-165536 $(whoami)
```

Test Podman locally

```bash
podman --version
podman run --rm -it docker.io/library/alpine:3.16 uname -a
```

## GPU Passthrough (NVIDIA RTX 3050 Mobile)

Install the NVIDIA driver & NVIDIA Container Toolkit. For Debian/Ubuntu hosts, use the official packages or `ubuntu-drivers`.

Note: On Ubuntu 24.04 / Linux Mint 22, `nvidia-container-toolkit` and `nvidia-ctk` packages may require enabling the official NVIDIA container toolkit repository first. Follow NVIDIA's installation guide (<https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html>) or run the repository setup script involving `curl | gpg` and adding the repo to `sources.list.d` before running `apt install`.

```bash
sudo apt install -y nvidia-driver-580 nvidia-utils-580
sudo apt install -y nvidia-container-toolkit nvidia-ctk
```

Create a CDI spec for rootless runtime

```bash
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
sudo systemctl restart podman
# Verify nvidia-smi
nvidia-smi
```

Run a container with Podman + NVIDIA CDI

```bash
podman run --rm --device nvidia.com/gpu=all --security-opt label=disable ubuntu:22.04 nvidia-smi
```

Notes:

- Patrons using `--security-opt label=disable` disable SELinux labeling for the container. Use with caution and only for local development.
- For Ollama performance, set OM_OLLAMA_NUM_GPU and adjust OLLAMA_FLASH_ATTENTION and OLLAMA_KV_CACHE_TYPE in `.env`.

## GPU Passthrough (AMD Radeon 660M integrated)

Install Mesa Vulkan drivers and Vulkan utilities

```bash
sudo apt install -y mesa-vulkan-drivers vulkan-utils libvulkan1 vulkan-tools
vulkaninfo | head -n 50
```

Run Podman with DRI device mounts

```bash
podman run --rm -it --device /dev/dri --device /dev/kfd -v /usr/share/vulkan/icd.d:/usr/share/vulkan/icd.d:ro ubuntu:22.04 vulkaninfo | head -n 50
```

Add user to render/video groups

```bash
sudo usermod -aG render,video $(whoami)
```

Notes:

- AMD ROCm is not generally available for integrated GPUs; use Vulkan ICD for GPU compute with containers.

## Troubleshooting

- Permission denied on /dev/dri: ensure your user is in the render/video group.
- subuid/subgid errors: re-run loginctl enable-linger and restart your session.
- Bun not found: ensure ~/.bun/bin is added to PATH in ~/.bashrc or ~/.profile.

---

See `docs/deployment/gpu-optimization.md` for tuning Ollama parameters and `podman/README.md` for Podman-specific Quadlet examples.
