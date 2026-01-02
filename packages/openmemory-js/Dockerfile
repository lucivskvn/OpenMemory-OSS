# ===== BUILD STAGE =====
FROM oven/bun:1 AS builder

WORKDIR /app

# Install system dependencies required for native modules if needed
# oven/bun is based on debian
RUN apt-get update && apt-get install -y python3 make g++ curl

# Copy package manifests
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

# Build
RUN bun run build

# ===== PRODUCTION STAGE =====
FROM oven/bun:1-slim AS production

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y ca-certificates python3 make g++ curl && rm -rf /var/lib/apt/lists/*

# Copy production artifacts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Create data directory
RUN mkdir -p /data \
  && chown -R bun:bun /data /app

USER bun

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

ENTRYPOINT ["bun", "run", "start"]