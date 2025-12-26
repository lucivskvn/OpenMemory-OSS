# ===== BUILD STAGE =====
FROM oven/bun:1.3.4 AS builder

WORKDIR /app

# Copy package manifests to install dependencies
COPY package.json ./

# Install all dependencies (including devDependencies) using Bun
RUN bun install --frozen-lockfile

# Copy source code and build the application
COPY src/ ./src/
COPY tsconfig.json ./
RUN bun run build

# ===== PRODUCTION STAGE =====
FROM oven/bun:1.3.4

WORKDIR /app

# Install system dependencies (ffmpeg for audio/video extraction)
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Create a dedicated non-root user for security (Bun image already has 'bun' user)
# We use 'bun' user which is ID 1000 usually.
# But existing setup used 1001. We can stick to 'bun' user.

# Copy only production artifacts from the builder stage
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/dist ./dist/
COPY package.json ./

# Create a directory for persistent data and secure file permissions
RUN mkdir -p /data \
 && chown -R bun:bun /data /app

# Switch to non-root user
USER bun

# Expose the application port
EXPOSE 8080

# Define a lightweight health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://localhost:8080/health').then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"

# Start the application using bun
ENTRYPOINT ["bun", "run", "start"]
