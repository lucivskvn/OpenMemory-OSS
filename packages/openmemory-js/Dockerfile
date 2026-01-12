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

# Create data directory
RUN mkdir -p /usr/src/app/data

# Environment Defaults
ENV NODE_ENV=production
ENV OM_PORT=8080
ENV OM_DB_PATH=/usr/src/app/data/openmemory.sqlite

# Security: Run as non-root user
RUN chown -R bun:bun /usr/src/app
USER bun

# Expose port
EXPOSE 8080

# Start command
CMD ["bun", "dist/server/start.js"]