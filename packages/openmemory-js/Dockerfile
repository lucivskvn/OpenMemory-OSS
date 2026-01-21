# Use specific version for stability
FROM oven/bun:1.1.29-alpine as base
WORKDIR /usr/src/app

# Install dependencies into temp directory
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lockb /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

RUN mkdir -p /temp/prod
COPY package.json bun.lockb /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# Builder stage
FROM base AS builder
COPY --from=install /temp/dev/node_modules node_modules
COPY . .
RUN bun run build

# Runtime stage
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=builder /usr/src/app/dist dist
COPY --from=builder /usr/src/app/package.json .


# Security: Run as non-root user
RUN addgroup -S -g 1001 openmemory && \
  adduser -S -u 1001 -G openmemory openmemory

# Create data directory and set permissions
RUN mkdir -p /data && chown -R openmemory:openmemory /data && chown -R openmemory:openmemory /usr/src/app

USER openmemory

# Environment Defaults
ENV NODE_ENV=production
ENV OM_PORT=3000
ENV OM_DB_PATH=/data/openmemory.sqlite
ENV OM_MODE=production

# Validation logic for OM_MODE can be added here or handled at runtime.
# Running as non-root user for security.

# Expose port
EXPOSE 3000

# Volume for persistent data
VOLUME ["/data"]

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${OM_PORT:-3000}/health || exit 1

# Start command
CMD ["bun", "dist/server/start.js"]