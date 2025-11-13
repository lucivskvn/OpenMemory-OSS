# ===== BUILD STAGE =====
# Use the official Bun image which comes with all necessary tools pre-installed.
FROM oven/bun:1.3.2-alpine AS builder

WORKDIR /app

# Copy package manifests to install dependencies
COPY package*.json ./
COPY bun.lockb ./

# Install all dependencies (including devDependencies) using Bun
# Use frozen lockfile when available; allow bun install to run if lockfile format differs
RUN if [ -f bun.lockb ]; then \
  bun install --frozen-lockfile || bun install; \
  else \
  bun install; \
  fi

# Copy source code and build the application
COPY src/ ./src/
COPY tsconfig.json ./
RUN bun run build
RUN [ -f dist/server/index.js ] || (echo "Build artifact missing: expected dist/server/index.js" && ls -la dist || true) && test -f dist/server/index.js

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

# Install production-only dependencies using frozen lockfile when available.
# Fallback to a standard install if `bun.lockb` is not present to avoid
# hard-failing builds in contributor environments where lockfile isn't committed.
RUN if [ -f bun.lockb ]; then \
  bun install --production --frozen-lockfile || bun install --production; \
  else \
  echo "bun.lockb not found — falling back to bun install --production"; \
  bun install --production; \
  fi

# Create a directory for persistent data and secure file permissions
RUN mkdir -p /data \
  && chown -R appuser:appgroup /data /app \
  && chmod -R go-w /app

# Switch to non-root user
USER appuser

# Expose the application port
EXPOSE 8080

# Start the application using Bun
ENTRYPOINT ["bun", "run", "start"]
