# GPU Optimization and Ollama Tuning

This guide describes GPU tuning for Ollama on systems with NVIDIA or AMD GPUs. It includes recommended env vars and device flags for Docker/Podman and performance tuning tips.

## Environment variables for Ollama

- `OM_OLLAMA_NUM_GPU` — number of GPUs allocated; 0 = CPU only, -1 = all GPUs
- `OLLAMA_FLASH_ATTENTION` — enable Flash Attention if supported by the model (NVIDIA 30-series/40-series)
- `OLLAMA_KV_CACHE_TYPE` — quantized cache type (e.g., `q8_0`) for memory tradeoffs
- `OLLAMA_VULKAN` — set to `1` to enable Vulkan backend for AMD GPUs

Example:

```bash
export OM_OLLAMA_NUM_GPU=1
export OLLAMA_FLASH_ATTENTION=1
export OLLAMA_KV_CACHE_TYPE=q8_0
export OLLAMA_VULKAN=1
```

## Docker-compose / Podman examples

NVIDIA example (docker-compose):

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    environment:
      - OM_OLLAMA_NUM_GPU=1
      - OLLAMA_FLASH_ATTENTION=1
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: ['all']
              capabilities: ['gpu']
```

Podman (rootless) usage with CDI

```bash
podman run --rm --device nvidia.com/gpu=all --security-opt label=disable ollama/ollama
```

AMD example (Vulkan):

```yaml
services:
  ollama:
    environment:
      - OLLAMA_VULKAN=1
    devices:
      - '/dev/dri:/dev/dri'
      - '/dev/kfd:/dev/kfd'
    volumes:
      - /usr/share/vulkan/icd.d:/usr/share/vulkan/icd.d:ro
```

## Performance benchmarks and targets

### Recommended GPU drivers (Linux Mint 22/Ubuntu 24.04)

**NVIDIA GPUs:**

- **Recommended driver**: NVIDIA 580.95.05 (CUDA 12.4+ support)
- Installation: `sudo apt install nvidia-driver-580 nvidia-utils-580 nvidia-ctk`
- Secure Boot: If using Secure Boot, complete MOK enrollment after installation
- Verification: `nvidia-smi` should show GPU information

**AMD GPUs:**

- **Recommended driver**: Mesa 24.x (open-source Vulkan with RADV implementation)
- Installation: `sudo apt install mesa-vulkan-drivers vulkan-tools`
- User groups: Add user to `render` and `video` groups: `sudo usermod -a -G render,video $USER`
- Verification: `vulkaninfo | head -20` should show RADV information

### Performance targets

- **CPU-only** `gen_syn_emb`:
  - target avg < 20 ms
  - P95 < 200 ms
- **GPU accelerated** (NVIDIA RTX 30xx/AMD Radeon 6xxx):
  - target P95 < 50 ms for realistic models
  - Memory usage: < 4GB for standard models

Performance will vary by model and GPU. Use `perf` tools and Ollama logs to tune.

## Troubleshooting

### NVIDIA issues

- `nvidia-smi` not found: ensure NVIDIA 580.95.05 drivers and nvidia-container-toolkit are installed
- Container GPU access: CDP and CDI configurations required for Podman/Docker
- Secure Boot blocking: Complete MOK enrollment process after driver installation

### AMD issues

- `vulkaninfo` errors: ensure Mesa 24.x Vulkan drivers are installed and ICD files available
- Permission errors: add user to `render` and `video` groups and ensure subuid/subgid configured
- Vulkan ICD: verify `/usr/share/vulkan/icd.d/radeon_icd.x86_64.json` exists

For deep-dive tuning, see `podman/README.md` and `docs/deployment/linux-mint-22-setup.md`.
