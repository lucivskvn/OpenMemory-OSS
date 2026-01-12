# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - 2026-01-12

### Added
- **Vector Store**: Hybrid HNSW/IVF tuning for Valkey and HNSW for Postgres (pgvector).
- **Temporal Graph**: Full temporal fact and edge management with validtime support.
- **CLI**: New `opm setup` and hybrid mode (local/remote).
- **Performance**: Optimized `ValkeyVectorStore` with explicit index parameters (`M=16`, `EF=200`).
- **Database**: Compound indexes for `memories` (salience, simhash) and `temporal_facts`.
- **SDK**: `MemoryClient` and `AdminClient` standardization.

### Changed
- Refactored `src/core/db.ts` to support strictly typed `getMem` and robust `insMems`.
- Unified `failed_logs` and `embed_logs` into `embed_logs` table.
- Hardened `maintenance.ts` with `DistributedLock` for concurrent safety.
- Updated `dashboard.css` with premium design tokens.

### Fixed
- Fixed `getMem` missing in `db.ts` causing integration test failures.
- Resolved `AdminClient` vs `MemoryClient` type signature mismatch.
- Fixed `SystemStats` type definition parity.
- Resolved vector store metadata inconsistency in SQLite fallback.

### Security
- Implemented `Secure by Default` mode requiring API keys.
- Added RBAC checks for User and Admin routes.
