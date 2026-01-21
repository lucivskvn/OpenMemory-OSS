# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - 2026-01-15

### Added
- **Database**: 
    - Full transaction nesting support using SAVEPOINTs for both SQLite and Postgres.
    - Transaction timeout (30s) to prevent deadlocks and connection leaks.
    - LRU eviction for statement cache (Max 100 statements).
    - Composite indices for performance optimization (`user_id + created_at`, `user_id + last_seen_at`, etc.).
    - Foreign key constraints for `vectors` and `waypoints` with `ON DELETE CASCADE`.
    - Automated query performance monitoring with slow query logging (>1s).
    - Database initialization idempotent with serialized concurrency control.
    - Automatic SQLite backups before migration execution.
- **Documentation**: New database guides for [Transaction Handling](docs/database/transaction-handling.md), [Migration Guide](docs/database/migration-guide.md), and [Performance Tuning](docs/database/performance-tuning.md).

### Fixed
- **Database**:
    - Fixed memory leak in `readyPromises` and database initialization locks.
    - Resolved SQL injection risk in dynamic table name logic via strict validation.
    - Fixed connection pool resource exhaustion with proper limits (`PG_MAX_CONNECTIONS`, `PG_IDLE_TIMEOUT`).
    - Resolved race condition in concurrent `getVectorStore` initialization.
    - Fixed placeholder conversion bug for queries with `?` in strings or `??`.
    - Corrected row mapping for `NULL` values in complex select queries.
    - Fixed migration version comparison bug to support multi-digit semver.
    - Improved database closure reliability during CLI exit and errors.
- **Migrations**: Reduced migration lock timeout from 120s to 30s to prevent deployment hangs.

## [0.1.0] - 2026-01-12
