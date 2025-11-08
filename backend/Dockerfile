# ===== BUILD STAGE =====
FROM oven/bun:1.3.1-alpine AS builder

WORKDIR /app

# Copy package manifests to install dependencies
COPY package*.json ./

# Install all dependencies (including devDependencies) using Bun
RUN bun install --production=false

# Copy source code and build the application
COPY src/ ./src/
COPY tsconfig.json ./
RUN bun run build


# ===== PRODUCTION STAGE =====
FROM oven/bun:1.3.1-alpine AS production

WORKDIR /app

# Create a dedicated non-root user for security
RUN addgroup -g 1001 -S appgroup \
 && adduser -u 1001 -S appuser -G appgroup

# Copy only production artifacts from the builder stage
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/dist ./dist/
COPY package.json ./

# Create a directory for persistent data and secure file permissions
RUN mkdir -p /data \
 && chown -R appuser:appgroup /data /app \
 && chmod -R go-w /app

# Switch to non-root user
USER appuser

# Add Podman-specific labels for auto-update and image information
LABEL io.containers.autoupdate="registry"
LABEL org.opencontainers.image.source="https://github.com/nullure/openmemory"
LABEL org.opencontainers.image.description="OpenMemory - Hierarchical Semantic Graph Memory System"

# Expose the application port
EXPOSE 8080

# Define a lightweight health check that verifies the /health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://localhost:8080/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Start the application using npm
ENTRYPOINT ["bun", "run", "start"]