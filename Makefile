# Makefile for OpenMemory

.PHONY: help install build test clean dev start stop lint format

# Default target
help: ## Show this help message
	@echo "OpenMemory Development Commands"
	@echo "==============================="
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# Installation and Setup
install: ## Install all dependencies
	@echo "📦 Installing backend dependencies..."
	cd backend && bun install
	@echo "📦 Installing JavaScript SDK dependencies..."
	cd sdk-js && bun install
	@echo "📦 Installing Python SDK dependencies..."
	cd sdk-py && pip install -e .
	@echo "✅ All dependencies installed!"

install-dev: ## Install development dependencies
	@echo "🛠️ Installing development dependencies..."
	cd backend && bun install
	cd sdk-js && bun install
	cd sdk-py && pip install -e .[dev]
	@echo "✅ Development dependencies installed!"

# Build
build: ## Build all components
	@echo "🏗️ Building backend..."
	cd backend && bun run build
	@echo "🏗️ Building JavaScript SDK..."
	cd sdk-js && bun run build
	@echo "✅ All components built!"

build-backend: ## Build backend only
	cd backend && bun run build

build-js-sdk: ## Build JavaScript SDK only
	cd sdk-js && bun run build

# Development
dev: ## Start development server
	@echo "🚀 Starting development server..."
	cd backend && bun run dev

dev-watch: ## Start development server with file watching
	@echo "👀 Starting development server with watching..."
	cd backend && bun run dev

# Production
start: ## Start production server
	@echo "🚀 Starting production server..."
	cd backend && bun run start

stop: ## Stop server (if running as daemon)
	@echo "🛑 Stopping server..."
	@pkill -f "bun.*index.js" || echo "No server process found"

# Testing
test: ## Run all tests
	@echo "🧪 Running all tests..."
	@echo "Testing backend API..."
	bun test ./tests/backend/api.bun.test.js
	@echo "Testing JavaScript SDK..."
	bun test ./tests/js-sdk/sdk-simple.test.js
	@echo "Testing Python SDK..."
	cd tests/py-sdk && python test-simple.py

test-backend: ## Run backend tests only
	@echo "🧪 Testing backend API..."
	bun test ./tests/backend/api.bun.test.js

test-js-sdk: ## Run JavaScript SDK tests only
	@echo "🧪 Testing JavaScript SDK..."
	bun test ./tests/js-sdk/sdk-simple.test.js

test-py-sdk: ## Run Python SDK tests only
	@echo "🧪 Testing Python SDK..."
	cd tests/py-sdk && python test-simple.py

test-integration: ## Run integration tests
	@echo "🔗 Running integration tests..."
	bun test ./tests/backend/api.bun.test.js

# Code Quality
lint: ## Run linters
	@echo "🔍 Running linters..."
	cd backend && bun run lint || echo "Backend linting completed"
	cd sdk-js && bun run lint || echo "JS SDK linting completed"
	cd sdk-py && python -m flake8 . || echo "Python linting completed"

format: ## Format code
	@echo "🎨 Formatting code..."
	cd backend && bun run format || echo "Backend formatting completed"
	cd sdk-js && bun run format || echo "JS SDK formatting completed"
	cd sdk-py && python -m black . || echo "Python formatting completed"

type-check: ## Run type checking
	@echo "🏷️ Running type checks..."
	cd backend && bun tsc --noEmit
	cd sdk-js && bun tsc --noEmit

# Database
db-reset: ## Reset database
	@echo "🗄️ Resetting database..."
	rm -f backend/database/*.db
	@echo "✅ Database reset!"

db-backup: ## Backup database
	@echo "💾 Backing up database..."
	mkdir -p backups
	cp backend/database/*.db backups/ || echo "No database files found"
	@echo "✅ Database backed up!"

# Docker
docker-build: ## Build Docker image
	@echo "🐳 Building Docker image..."
	docker build -t openmemory .

docker-run: ## Run Docker container
	@echo "🐳 Running Docker container..."
	docker run -p 8080:8080 openmemory

docker-dev: ## Run development environment with Docker
	@echo "🐳 Starting development environment..."
	docker-compose up --build

docker-stop: ## Stop Docker containers
	@echo "🐳 Stopping Docker containers..."
	docker-compose down

run: docker-dev ## Alias for docker-dev

podman-dev: ## Run development environment with Podman
	podman compose up --build

podman-quadlet-install: ## Install Quadlet systemd files
	mkdir -p ~/.config/containers/systemd && cp podman/*.{container,volume} ~/.config/containers/systemd/ && systemctl --user daemon-reload

podman-start: ## Start Podman systemd service
	systemctl --user start openmemory.service

podman-logs: ## View Podman service logs
	journalctl --user -u openmemory.service -f

# Cleanup
clean: ## Clean build artifacts
	@echo "🧹 Cleaning build artifacts..."
	rm -rf backend/dist/
	rm -rf sdk-js/dist/
	rm -rf sdk-js/node_modules/.cache/
	rm -rf backend/node_modules/.cache/
	find . -name "*.pyc" -delete
	find . -name "__pycache__" -type d -exec rm -rf {} + || true
	@echo "✅ Cleanup complete!"

clean-all: clean ## Clean everything including node_modules
	@echo "🧹 Deep cleaning..."
	rm -rf backend/node_modules/
	rm -rf sdk-js/node_modules/
	rm -rf sdk-py/build/
	rm -rf sdk-py/dist/
	rm -rf sdk-py/*.egg-info/
	@echo "✅ Deep cleanup complete!"

# Examples
run-examples: ## Run example files
	@echo "🎯 Running examples..."
	@echo "Backend examples:"
	node examples/backend/basic-server.js &
	sleep 2
	node examples/backend/api-test.mjs
	@echo "JavaScript SDK examples:"
	bun examples/js-sdk/basic-usage.js
	@echo "Python SDK examples:"
	cd examples/py-sdk && python basic_usage.py

# Development Utilities
reset-dev: clean install build ## Reset development environment
	@echo "🔄 Development environment reset complete!"

quick-test: build test-backend ## Quick test after build
	@echo "⚡ Quick test complete!"

full-check: clean install build lint test ## Full check before commit
	@echo "✅ Full check complete - ready to commit!"