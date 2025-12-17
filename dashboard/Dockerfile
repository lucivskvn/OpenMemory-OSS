# ===== BUILD STAGE =====
FROM oven/bun:1.3.4 AS builder

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build the Next.js application
RUN bun run build

# ===== PRODUCTION STAGE =====
FROM oven/bun:1.3.4

WORKDIR /app

# Install only production dependencies (or copy if bun works that way, usually bun install --production)
# Copying node_modules from builder is safer if we want exact same.
COPY --from=builder /app/node_modules ./node_modules
# Actually Next.js standalone mode is often better, but let's stick to standard run
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY package.json ./

# Create a dedicated non-root user for security
RUN chown -R bun:bun /app

USER bun

# Expose the application port
EXPOSE 3000

# Set environment to production
ENV NODE_ENV=production

# Start the Next.js application
CMD ["bun", "start"]
