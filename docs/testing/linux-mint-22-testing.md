# Linux Mint 22 Testing Guide

This guide provides step-by-step instructions for testing OpenMemory on Linux Mint 22 (Ubuntu 24.04 base) with Bun v1.3.2. It covers prerequisites, backend testing, dashboard testing, E2E testing, benchmarks, and CI simulation, ensuring self-contained local testing with GPU and Podman support.

## Prerequisites

Install system dependencies, Bun, Podman, and GPU drivers. Reference `docs/deployment/linux-mint-22-setup.md` for detailed setup.

### System Dependencies

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl unzip ca-certificates build-essential libssl-dev git pkg-config podman podman-compose podman-docker
# Optional: jq and vim for convenience
# sudo apt install -y jq vim
```

### Bun v1.3.2 Installation

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.2"
export PATH="$HOME/.bun/bin:$PATH"
bun --version  # Should output: 1.3.2
```

### Podman Rootless Setup

```bash
sudo loginctl enable-linger $(whoami)
grep $(whoami) /etc/subuid || sudo usermod --add-subuids 100000-165536 $(whoami)
grep $(whoami) /etc/subgid || sudo usermod --add-subgids 100000-165536 $(whoami)
podman --version
podman run --rm -it docker.io/library/alpine:3.16 uname -a
```

### GPU Drivers - NVIDIA RTX 3050 Mobile

```bash
sudo apt install -y nvidia-driver-535 nvidia-utils-535 nvidia-container-toolkit nvidia-ctk
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
sudo systemctl restart podman
nvidia-smi
podman run --rm --device nvidia.com/gpu=all --security-opt label=disable ubuntu:22.04 nvidia-smi
```

### GPU Drivers - AMD Radeon 660M Integrated

```bash
sudo apt install -y mesa-vulkan-drivers vulkan-utils libvulkan1 vulkan-tools
sudo usermod -aG render,video $(whoami)
vulkaninfo | head -n 50
podman run --rm -it --device /dev/dri --device /dev/kfd -v /usr/share/vulkan/icd.d:/usr/share/vulkan/icd.d:ro ubuntu:22.04 vulkaninfo | head -n 50
```

See `docs/deployment/linux-mint-22-setup.md` for GPU optimizations and `docs/deployment/gpu-optimization.md` for Ollama tuning.

## Backend Testing

Test backend functionality with Bun's native runtime.

### Unit Tests

```bash
cd backend
bun install --frozen-lockfile
bun test
```

### CI Tests

```bash
cd backend
bun run test:ci  # Includes coverage and JSON reporter
```

### Performance Tests

Enable perf tests for latency measurements:

```bash
OM_RUN_PERF_TESTS=true bun run test:ci
```

Expected: unit tests pass, integration tests complete without errors, perf assertions <50ms P95 for embeddings.

## Dashboard Testing

Test Next.js dashboard with Vercel AI SDK v5 streaming.

### Setup

```bash
cd dashboard
bun install --frozen-lockfile
bun run verify:bun  # Outputs Bun and Next.js versions
```

Create `.env.local`:

```bash
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_API_KEY=your-api-key-here
```

### Development Server

```bash
bun run dev
# Dashboard: http://localhost:3000
```

### AI SDK Streaming Verification

Ensure backend runs on port 8080:

```bash
cd backend
OM_API_KEY=your-hashed-key bun run dev
```

In dashboard chat interface, verify:

- User input sends query
- Server streams response chunks with `{role: 'assistant', content: ...}` format (Vercel AI SDK v5.0.93 standard)
- Memories are retrieved and injected, telemetry markers present
- Streaming completes without errors

**Note**: Integration uses Vercel AI SDK v5.0.93 end-to-end with `streamText` + `toUIMessageStreamResponse`.

### AI SDK v5.0.93 Specific Verification

Ensure the AI SDK is correctly installed and that Bun's Web APIs interoperate with the SDK.

1. Version check (dashboard):

```bash
cd dashboard
bun pm ls ai  # expect ai@5.0.93
```

2. Import test (simple):

```bash
cat > /tmp/test-ai-sdk.ts << 'EOF'
import { useChat, useCompletion } from '@ai-sdk/react'
import { streamText } from 'ai'
console.log('AI SDK v5 import OK')
EOF
cd dashboard && bunx --bun tsx /tmp/test-ai-sdk.ts
rm /tmp/test-ai-sdk.ts
```

3. Streaming test (manual):

- Start backend: `cd backend && bun run dev` (port 8080)
- Start dashboard: `cd dashboard && bun run dev` (port 3000)
- Open the Chat page and verify SSE/network streaming in DevTools

4. Automated verification: use the script in `dashboard/scripts/verify-ai-sdk.ts`

```bash
cd dashboard
bun run verify:ai-sdk
```

5. Benchmark verification:

```bash
cd backend
bun run test:benchmarks
```

Expect TTFT <500ms, TPS >20 for AI SDK tests

- First chunk <200ms, total response <5s

See `dashboard/app/api/chat/route.ts` for chat endpoint implementation.

## E2E Testing

Full-stack end-to-end tests using Bun.

```bash
cd backend
bun run test:e2e
```

Tests startup backend on random port, mock fetch for cross-service calls, verify chat streaming, assert performance <100ms ingestion P95, <50ms query, <200ms streaming first chunk.

Self-contained: no external dependencies, ports auto-assigned.

## Benchmarks

Comparative performance testing.

### Local Benchmarks

```bash
cd backend
bun run test:benchmarks  # Competitor comparisons
bun run benchmark:embed  # SIMD performance
bun run benchmark:report # HTML report generation
```

Outputs JSON to `tests/benchmarks/results/` with TTFT, TPS, total time, tokens. Consolidated report shows changes vs baselines.

### Hardware Baselines

- Hardware: Ryzen 5 5600H, 16GB RAM
- Metrics: recall@K >=0.7/0.85, P95 <50ms, QPS >200, cost $0 synthetic, mem <600MB
- Comparisons: Mem0, Zep (Nov 2025 baselines)

See `docs/testing/benchmark-tracking.md` for full tracking.

## CI Simulation

Simulate GitHub Actions locally using `act`.

### Prerequisites

```bash
# Install act
curl -s https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash
```

### Run CI Locally

```bash
act -j test --container-architecture linux/amd64
act -j benchmark --container-architecture linux/amd64
```

### Security Scanning

```bash
# Trivy filesystem scan
docker run --rm -v $(pwd):/workspace aquasecurity/trivy:0.55.1 fs --format sarif --output /workspace/trivy-results.sarif /workspace

# SLSA attestation check (if images built)
cosign verify-blob --certificate-identity-regexp 'https://github.com/lucivskvn/openmemory-OSS/.github/workflows/ci.yml@refs/heads/main' --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' image.tar.gz
```

## Troubleshooting

### Permission Issues

```bash
# Podman subuid/subgid
sudo loginctl enable-linger $(whoami) && sudo systemctl restart podman

# GPU groups
sudo usermod -aG render,video $(whoami)
# Reboot or new login session
```

### GPU Passthrough Failures

```bash
# NVIDIA CDI
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
# Restart Podman daemon
sudo systemctl restart podman

# AMD Vulkan
sudo apt reinstall mesa-vulkan-drivers
vulkaninfo  # Verify ICD available
```

### Flaky Tests

Enable debug logging:

```bash
TEST_DEBUG=1 bun run test:e2e
```

Common issues:

- Port conflicts: Tests use random ports, but check if 8080 is free for dashboard
- Podman timeouts: Ensure linger enabled, restart user session
- GPU not detected: Reinstall drivers, check groups

### Bun Module Resolution

```bash
rm -rf node_modules bun.lockb
bun install --frozen-lockfile
```

### AI SDK Streaming Issues

- Verify backend health: `curl http://localhost:8080/health`
- Check `.env.local` URLs
- Browser dev tools: Check network tab for SSE (text/event-stream)
- Logs: Watch backend for chat endpoint calls

#### AI SDK Issues on Mint 22

- Ensure real LLM provider configured: `bun add @ai-sdk/openai` or `@ai-sdk/ollama`, set OPENAI_API_KEY or OLLAMA_URL=http://localhost:11434
- Verify streaming format: `curl -v POST /api/chat` (expect text/event-stream with standard AI SDK message format)
- Common: Missing libssl-dev causes native builds to fail; restart after adding to render/video groups for GPU access

See `CONTRIBUTING.md` for additional patterns and `AGENTS.md` for Bun-first guidelines.
