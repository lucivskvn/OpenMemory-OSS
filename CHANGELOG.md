<!-- markdownlint-disable MD024 -->
# Changelog

## [Unreleased]

### Added

- Bun-native developer notes and CI guidance (`docs/deployment/bun-native.md`).
- Documentation updates for Bun-first development: `CONTRIBUTING.md`, `AGENTS.md`, `README.md`, and supporting notes (`docs/notes/agents-bun-addendum.md`).

### Changed

- Recommend Bun v1.3.2+ for local development and CI; add `@types/bun` guidance for TypeScript editing environments and `tsconfig.json` recommendations.

### Notes

This section groups the recent documentation and developer-ergonomics changes and is intentionally left as "Unreleased" until a formal release is published.

## [1.3.1] - 2025-11-12

### Added

- Bun.file() helpers and file-based extract/ingest wrappers in `backend/src/ops/extract.ts` and `backend/src/ops/ingest.ts` for faster document processing and simpler file I/O.
- `backend/src/utils/crypto.ts` — centralized cryptographic helpers (password hashing, safe comparisons) used by `auth` middleware.
- CI security improvements: Trivy scans (filesystem + image), SLSA provenance attestation for published images, and Dependabot coverage for npm/pip.
- Documentation: `CONTRIBUTING.md` (Bun best-practices), `AGENTS.md` (agent schema and Bun tips), `docs/deployment/oidc-setup.md`, `docs/security/github-actions-hardening.md`.

### Changed

- Workflows: SHA-pinned GitHub Actions, reduced top-level permissions, and job-scoped elevations for publishing and SARIF uploads.
- File I/O: normalize ArrayBuffer/TypedArray to Node `Buffer` for third-party libraries while using `Bun.file()` for efficient streaming.
- Auth: refactored to use `backend/src/utils/crypto.ts` for hashing and verification.

### Fixed

- Pinned `@xenova/transformers` to `^2.17.2` for dependency stability. Upgrade via Dependabot PRs only.

### Security

- Enforced least-privilege in CI: `contents: read` globally, `packages: write`/`attestations: write`/`id-token: write` only on publish job, and `security-events: write` scoped to the security-scan job for SARIF uploads.
- Added Trivy SARIF uploads to enable GitHub Security tab integration.

### Performance

- File I/O performance: 2–3x faster document processing for extract/ingest paths using `Bun.file()` (measured on Ubuntu 22.04, 4 vCPU).

### Notes

- Backward compatible; no breaking API changes. Recommend Bun v1.3.2+ for development and CI.

## [1.3.0] - 2025-11-11

### Added

- Bun runtime support and migration guide (Bun v1.3.2+)
- Podman Quadlet deployment files for rootless systemd
- Optional hybrid embedding fusion (semantic + synthetic) for improved recall/perf

- Enforce hashed API keys for `OM_API_KEY` at runtime. Plaintext keys are rejected; use the helper script at `backend/scripts/hash-api-key.ts` to generate argon2-compatible hashes suitable for repository secrets.
- A GitHub Actions workflow `.github/workflows/validate-om-api-key.yml` was added to validate that the `OM_API_KEY` repository secret looks hashed on PRs (skips when secret is absent to avoid blocking forks).
- Consolidated backend operational docs into `backend/README.md` (previously `backend/API_KEYS.md` was removed).
- Minimal TypeScript declarations for Bun's sqlite module (`backend/src/types/bun-sqlite.d.ts`) were added to improve typing and remove ts-ignore usages.
- Unit test covering legacy vs modern handler behavior added: `tests/backend/legacy-handler.test.ts`.

### Changed

- Backend runtime: Node -> Bun (opt-in). See MIGRATION.md for steps.

- Server invocation model now distinguishes legacy handlers (marked with `handler.__legacy = true`) from modern handlers which must return a `Response` or a serializable value; modern handlers that return `undefined` will result in a 500 with guidance to mark legacy handlers or return a proper response.
- SQLite DB usage updated to prefer `db.run`/`db.prepare` over deprecated `db.exec` overloads; PRAGMA handling adjusted to avoid parameterized placeholders where unsupported.
- Backend README now includes migration guidance for hashed API keys and operational tips; root README links to backend docs and the changelog for recent updates.

### Performance

- Bun runtime brings improved startup times and query performance in many cases.

### Fixed

- Tests and typing updates: backend tests pass locally after changes (22 tests, 0 failures at time of update).

## 1.2

### Added

- **Multi-Tenant Support with User Isolation**

  - Complete per-user memory isolation via `user_id` field
  - Automatic user summary generation and management
  - User-scoped queries, stats, and memory operations
  - REST API endpoints:
    - `GET /users/:userId/summary` - Get user memory summary
    - `GET /users/:userId/stats` - Get user statistics
    - `POST /memory/add` with `user_id` field
    - `POST /memory/query` with `filters.user_id`
  - Database schema with user_id indexing for performance
  - Migration tool preserves user isolation during import
  - Full user namespace separation in memory storage

- **Migration Tool for Competitor Import**

  - Standalone CLI tool to migrate from Zep, Mem0, and Supermemory to OpenMemory
  - API-based architecture (no backend dependencies required)
  - Automatic rate limiting for billion-scale exports:
    - Zep: 1 req/s (session-based iteration)
    - Mem0: 20 req/s (user-based export with Token authentication)
    - Supermemory: 5-25 req/s (document pagination)
  - Features:
    - Preserves user isolation and metadata
    - JSONL export format for portability
    - Built-in verification via OpenMemory API
    - Progress tracking and resume support
    - Automatic retry on rate limit (429) errors
  - Reads backend configuration from root `.env` file (`OM_PORT`, `OM_API_KEY`)
  - Environment variable fallback chain: CLI flags → `OPENMEMORY_*` → `OM_*` → defaults
  - Example: `bun migrate/index.js --from mem0 --api-key KEY --verify`
  - Full documentation in `migrate/README.md`

- **HYBRID Tier Performance Mode**

  - New tier achieving 100% keyword match accuracy with synthetic embeddings
  - BM25 scoring algorithm for relevance ranking
  - Exact phrase matching with case-insensitive search
  - N-gram keyword extraction (unigrams, bigrams, trigrams)
  - Performance: 800-1000 QPS, 0.5GB RAM per 10k memories
  - Configurable via `OM_TIER=hybrid`, `OM_KEYWORD_BOOST`, `OM_KEYWORD_MIN_LENGTH`
  - Best for: Documentation search, code search, technical references

- **Memory Compression Engine**: Auto-compresses chat/memory content to reduce tokens and latency

  - 5 compression algorithms: whitespace, filler, semantic, aggressive, balanced
  - Auto-selects optimal algorithm based on content analysis
  - Batch compression support for multiple texts
  - Live savings metrics (tokens saved, latency reduction, compression ratio)
  - Real-time statistics tracking across all compressions
  - Integrated into memory storage with automatic compression
  - REST API endpoints: `/api/compression/compress`, `/api/compression/batch`, `/api/compression/analyze`, `/api/compression/stats`
  - Example usage in `examples/backend/compression-examples.mjs`

- **VS Code Extension with AI Auto-Link**

  - Auto-links OpenMemory to 6 AI tools: Cursor, Claude, Windsurf, GitHub Copilot, Codex
  - Dual mode support: Direct HTTP or MCP (Model Context Protocol)
  - Status bar UI with clickable menu for easy control
  - Toggle between HTTP/MCP mode in real-time
  - Zero-config setup - automatically detects backend and writes configs
  - Performance optimizations:
    - **ESH (Event Signature Hash)**: Deduplicates ~70% redundant saves
    - **HCR (Hybrid Context Recall)**: Sub-80ms queries with sector filtering
    - **MVC (Micro-Vector Cache)**: 32-entry LRU cache saves ~60% embedding calls
  - Settings for backend URL, API key, MCP mode toggle
  - Postinstall script for automatic setup

- **API Authentication & Security**

  - API key authentication with timing-safe comparison
  - Rate limiting middleware (configurable, default 100 req/min)
  - Compact 75-line auth implementation
  - Environment-based configuration

- **CI/CD**
  - GitHub Action for automated Docker build testing
  - Ensures Docker images build successfully on every push

### Changed

- Optimized all compression code for maximum efficiency
- Removed verbose comments and long variable names
- Active voice, casual naming convention throughout compression engine
- Streamlined memory routes with integrated compression
- Ultra-compact compression implementation (<100 lines core logic)

### Fixed (continued)

- **MCP Tool Names (Breaking Change)**: Changed from dot notation to underscores for Windsurf IDE compatibility

  - `openmemory.query` → `openmemory_query`
  - `openmemory.store` → `openmemory_store`
  - `openmemory.reinforce` → `openmemory_reinforce`
  - `openmemory.list` → `openmemory_list`
  - `openmemory.get` → `openmemory_get`
  - Complies with MCP naming rule: `^[a-zA-Z0-9_-]{1,64}$`

- **PostgreSQL Custom Table Name**: Fixed hardcoded `memories` table in `openmemory://config` resource
  - Now correctly uses `OM_PG_TABLE` environment variable
  - Exports `memories_table` from database module with fully-qualified name
  - Fixes "relation 'memories' does not exist" error with custom table names
  - Works for both PostgreSQL (with schema) and SQLite

### Fixed

- VS Code extension connection issues (health endpoint)
- MCP protocol integration for AI tools
- Extension now properly passes MCP flag to all writers
