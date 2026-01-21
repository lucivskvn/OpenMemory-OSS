# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.1] - 2026-01-15

### Security
- **Hardening**: Implemented "Fail-Closed" authentication in Python Server (`dependencies.py`).
- **Web Crawler**: Added strict streaming body read with 10MB limit to prevent OOM/DoS attacks.
- **Rate Limiting**: Enforced fail-closed strategy on Redis connection failures.
- **Encryption**: Added TTL to encryption key cache to prevent stale keys in memory.
- **Timing Attacks**: Implemented `crypto.timingSafeEqual` for all critical key comparisons.

### Added
- **Performance**: Added `idx_vectors_sector_user` (Migration 1.12.0) for optimized filtered vector search.
- **Dashboard**: Added explicit Error and Empty states to `GraphView` with retry actions.
- **Docs**: Added `SECURITY.md` and root `CHANGELOG.md`.

### Fixed
- **MCP**: Fixed bug where GET endpoint returned 405 (Issue #126).

### Changed
- **Python SDK**: Updated default `vec_dim` to 768 (Hybrid) for cross-SDK parity.
- **Python SDK**: Prioritized `OM_` prefixed environment variables in configuration.
- **Temporal Graph**: Added strict input validation for blank strings in Facts and Edges.
- **Dependencies**: Updated `zod` to v4.3.5 and `psycopg` to v3 (Python).

## [1.3.2] - 2025-12-06

### Added
- Initial Changelog creation.
