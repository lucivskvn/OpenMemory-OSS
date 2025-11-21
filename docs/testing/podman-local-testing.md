# Podman Local Testing Guide

This guide covers local build and testing for OpenMemory Dashboard and VSCode Extension using rootless Podman containers.

## Prerequisites

Install Podman on Linux Mint 22 / Ubuntu 24.04:

```bash
sudo apt update
sudo apt install -y podman podman-compose
```

Verify installation:

```bash
podman --version
# Should show: podman version 4.3.1 or later
```

## Dashboard Testing

### Quick Test

Run the automated test script:

```bash
# From repo root
./scripts/podman-test-dashboard.sh
```

This script will:

- Build a production Dashboard container image
- Start the container on port 3000
- Verify it responds to HTTP requests
- Clean up test containers

### Manual Testing

Build the Dashboard image:

```bash
cd dashboard
podman build -t openmemory-dashboard:local -f- . <<'EOF'
FROM oven/bun:1.3.2-alpine AS base
WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:1.3.2-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=base /app/.next/standalone ./
COPY --from=base /app/.next/static ./.next/static
COPY --from=base /app/public ./public

EXPOSE 3000
CMD ["bun", "server.js"]
EOF
```

Run the container:

```bash
podman run -d \
  --name openmemory-dashboard \
  -p 3000:3000 \
  -e BACKEND_URL=http://localhost:8080 \
  openmemory-dashboard:local
```

Test the Dashboard:

```bash
# Check if running
podman ps | grep openmemory-dashboard

# View logs
podman logs -f openmemory-dashboard

# Test HTTP endpoint
curl http://localhost:3000

# Stop and cleanup
podman stop openmemory-dashboard
podman rm openmemory-dashboard
```

## VSCode Extension Testing

### Automated Test

Run the automated test script:

```bash
# From repo root
./scripts/podman-test-vscode-ext.sh
```

This script will:

- Build the VSCode Extension in a container
- Package it as a VSIX file
- Verify the build completed successfully

### Manual Build and Test

Build the extension image:

```bash
cd IDE
podman build -t openmemory-vscode:local -f- . <<'EOF'
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run compile || npx tsc -p ./

FROM node:20-alpine
WORKDIR /app

RUN npm install -g @vscode/vsce

COPY --from=builder /app ./
RUN vsce package --no-git-tag-version

CMD ["sh", "-c", "ls -lh *.vsix"]
EOF
```

Extract the VSIX file:

```bash
# Run container and copy VSIX to host
podman run --rm -v $(pwd):/output openmemory-vscode:local sh -c 'cp *.vsix /output/'

# Install in VS Code
code --install-extension openmemory-*.vsix
```

## Troubleshooting

### Dashboard Build Issues

**Issue**: Bun segfaults during Next.js build  
**Solution**: Use Node.js fallback for dashboard builds:

```bash
cd dashboard
bun run build:node  # Uses Next.js with Node.js instead of Bun runtime
```

**Issue**: Permission errors with rootless Podman  
**Solution**: Ensure user namespaces are configured:

```bash
# Check subuid/subgid mappings
cat /etc/subuid
cat /etc/subgid

# If missing, add your user
sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER

# Restart podman
systemctl --user restart podman
```

### VSCode Extension Issues

**Issue**: npm install fails in container  
**Solution**: Use `--legacy-peer-deps` flag or update peer dependencies

**Issue**: VSIX package too large  
**Solution**: Ensure `.vscodeignore` properly excludes node_modules and build artifacts

## Integration with CI

These Podman tests complement the GitHub Actions CI pipeline. Local testing is recommended before pushing:

```bash
# Full local validation workflow
cd /path/to/OpenMemory-OSS

# 1. Backend tests
cd backend
bun run test

# 2. Dashboard build (use Node.js for stability)
cd ../dashboard
bun run build:node

# 3. Podman container tests
cd ..
./scripts/podman-test-dashboard.sh
./scripts/podman-test-vscode-ext.sh

# 4. Benchmark utilities
bun scripts/benchmark-utils.ts cleanup
```

## Performance Notes

- **Dashboard build time**: ~60-90s (Node.js) vs ~30-40s (Bun runtime, but unstable)
- **Container size**: Dashboard ~150MB, VSCode Extension ~80MB (Alpine base)
- **Memory usage**: Dashboard container ~200MB RSS, VSCode build ~300MB peak

## Related Documentation

- [Linux Mint 22 Setup Guide](../deployment/linux-mint-22-setup.md)
- [GPU Optimization](../deployment/gpu-optimization.md)
- [Main README](../../README.md)
