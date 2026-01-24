#!/bin/bash

# OpenMemory Docker Test Runner
# Runs tests with Redis, Valkey, and PostgreSQL in Docker containers

set -e

echo "🐳 Starting OpenMemory Docker Test Environment"
echo "=============================================="

# Clean up any existing containers
echo "🧹 Cleaning up existing containers..."
docker-compose -f docker-compose.test.yml down --volumes --remove-orphans 2>/dev/null || true

# Start test services
echo "🚀 Starting test services..."
docker-compose -f docker-compose.test.yml up -d redis valkey postgres-test

# Wait for services to be ready
echo "⏳ Waiting for services to be ready..."
sleep 10

# Check service health
echo "🔍 Checking service health..."
docker-compose -f docker-compose.test.yml exec -T redis redis-cli ping || echo "Redis not ready"
docker-compose -f docker-compose.test.yml exec -T valkey valkey-cli ping || echo "Valkey not ready"
docker-compose -f docker-compose.test.yml exec -T postgres-test pg_isready -U test || echo "PostgreSQL not ready"

# Run tests
echo "🧪 Running tests..."
if docker-compose -f docker-compose.test.yml run --rm openmemory-test; then
    echo "✅ All tests passed!"
    exit_code=0
else
    echo "❌ Some tests failed!"
    exit_code=1
fi

# Cleanup
echo "🧹 Cleaning up..."
docker-compose -f docker-compose.test.yml down --volumes

exit $exit_code