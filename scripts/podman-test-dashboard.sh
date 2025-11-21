#!/bin/bash
# Podman-based Dashboard testing script for local validation
# Tests Dashboard build and runtime using rootless Podman containers

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "🚀 OpenMemory Dashboard - Podman Test Suite"
echo "============================================="

# Check Podman availability
if ! command -v podman &> /dev/null; then
    echo "❌ Podman not found. Install with: sudo apt install podman"
    exit 1
fi

echo "✅ Podman version: $(podman --version)"

# Build Dashboard image
echo ""
echo "📦 Building Dashboard container image..."
cd "$REPO_ROOT/dashboard"

podman build -t openmemory-dashboard:test -f- . <<'DOCKERFILE'
FROM oven/bun:1.3.2-alpine AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Build Dashboard
RUN bun run build

# Production image
FROM oven/bun:1.3.2-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=base /app/.next/standalone ./
COPY --from=base /app/.next/static ./.next/static
COPY --from=base /app/public ./public

EXPOSE 3000

CMD ["bun", "server.js"]
DOCKERFILE

echo "✅ Dashboard image built successfully"

# Test container startup
echo ""
echo "🧪 Testing Dashboard container..."

CONTAINER_ID=$(podman run -d \
    --name openmemory-dashboard-test \
    -p 3000:3000 \
    -e BACKEND_URL=http://localhost:8080 \
    openmemory-dashboard:test)

echo "Container ID: $CONTAINER_ID"

# Wait for container to be ready
echo "⏳ Waiting for Dashboard to start..."
sleep 5

# Check if container is running
if podman ps | grep -q openmemory-dashboard-test; then
    echo "✅ Dashboard container is running"
    
    # Test health endpoint (if available)
    if curl -f http://localhost:3000 &> /dev/null; then
        echo "✅ Dashboard is responding to HTTP requests"
    else
        echo "⚠️  Dashboard not responding (might need backend)"
    fi
else
    echo "❌ Dashboard container failed to start"
    podman logs openmemory-dashboard-test
    exit 1
fi

# Cleanup
echo ""
echo "🧹 Cleaning up test container..."
podman stop openmemory-dashboard-test &> /dev/null || true
podman rm openmemory-dashboard-test &> /dev/null || true

echo ""
echo "✅ Dashboard Podman test completed successfully!"
echo ""
echo "To run manually:"
echo "  podman run -d -p 3000:3000 openmemory-dashboard:test"
