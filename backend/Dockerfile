# ===== BUILD STAGE =====
# Use the official Bun image which comes with all necessary tools pre-installed.
FROM oven/bun:1.3.2-alpine AS builder

WORKDIR /app

# Copy package manifests to install dependencies
COPY package*.json ./
COPY bun.lockb ./

# Install all dependencies (including devDependencies) using Bun
RUN bun install --frozen-lockfile

# Copy source code and build the application
COPY src/ ./src/
COPY tsconfig.json ./
RUN bun run build

# ===== PRODUCTION STAGE =====
FROM oven/bun:1.3.2-alpine AS production

WORKDIR /app

# Create a dedicated non-root user for security
RUN addgroup -g 1001 -S appgroup \
 && adduser -u 1001 -S appuser -G appgroup

# Copy only necessary files for production
COPY --from=builder /app/dist ./dist/
COPY package.json ./
COPY bun.lockb ./

# Install production-only dependencies
RUN bun install --production

# Create a directory for persistent data and secure file permissions
RUN mkdir -p /data \
 && chown -R appuser:appgroup /data /app \
 && chmod -R go-w /app

# Switch to non-root user
USER appuser

# Expose the application port
EXPOSE 8080

# Define a health check using Bun's native fetch
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://localhost:8080/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Start the application using Bun
ENTRYPOINT ["bun", "run", "start"]
