Title: Migrate backend PostgreSQL usage from `pg` to Bun native Postgres client

Status: open

Description:

The backend currently depends on the `pg` package for PostgreSQL connectivity. To fully leverage Bun's runtime performance and native Postgres bindings, we should migrate `backend/src/core/db.ts` to use `Bun.postgres` (or the appropriate Bun Postgres API) and then remove the `pg` dependency from `backend/package.json`.

Acceptance criteria:

- `backend/src/core/db.ts` uses Bun's Postgres client for all Postgres connections when running under Bun.
- The module preserves the helper functions `run_async`, `get_async`, `all_async` and supports nested transactions using savepoints.
- All integration tests that rely on Postgres pass under Bun.
- `pg` is removed from `backend/package.json` and replaced by Bun-native usage. A migration note is added to `MIGRATION.md`.

Notes and migration steps:

1. Investigate Bun.postgres API and implementation details for connection pooling and transactions.
2. Implement a pool or pooling fallback that supports concurrent queries in tests/CI.
3. Ensure schema creation and migration commands work under the Bun client (handle database-not-found errors by creating DB when possible).
4. Run `bun run build` and `bun test` in `backend/` and validate success.
5. Remove `pg` from dependencies and update `bun.lock`.

If a contributor wants to take this on, comment on this issue with the environment details and planned approach.
