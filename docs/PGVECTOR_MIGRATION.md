# pgvector Migration Plan

Note: This migration is only relevant for Postgres deployments (Supabase or other providers). If you are using SQLite-only mode (default), you can skip the pgvector migration steps.

Goal: Safely migrate vector storage to use Postgres `pgvector` column (`v_vector`) and leverage DB-side similarity search (ivfflat/HNSW) for performance.

Prerequisites

- Ensure you have a complete backup of the database.
- Ensure you have admin access to the Postgres instance (to create extensions and alter tables).
- Ensure `pgvector` extension is supported by your Postgres provider (Supabase, managed providers may vary).

High-level steps

1. **Pre-checks**
   - Verify current vector column exists and is bytea (`v`).
   - Verify vector dimension used by the app (`OM_VEC_DIM` / `env.vec_dim`).
   - Add tests or a staging DB to validate performance and correctness.

2. **Add pgvector column (SQL)**
   - Run the provided migration `supabase/migrations/20240107000000_pgvector.sql` which:
     - Creates `pgvector` extension (if supported).
     - Adds `v_vector` column (vector type) to `openmemory_vectors` if missing.
     - Attempts to create an IVFFLAT index (may fail until dimension is set correctly).

   Note: The IVFFLAT index creation may require the column to have an explicit dimension or require you to run `SET vector_dimensions = <dim>` depending on pgvector version.

3. **Backfill existing rows**
   - Use `tools/backfill_pgvector.ts` to convert the existing `bytea` binary vectors stored in `v` into `v_vector` for each row.
   - The tool connects to Postgres and updates `v_vector` using text array/pgvector literal casting.
   - Run the backfill in batches using `BACKFILL_BATCH` environment variable (default 1000) to avoid long-running transactions and OOMs. The script also supports `OM_VEC_DIM` to validate vector dimension before update and skips rows with mismatched lengths.
   - Example: `OM_PG_HOST=... OM_PG_USER=... OM_PG_PASSWORD=... OM_VEC_DIM=1536 BACKFILL_BATCH=500 bun run tools/backfill_pgvector.ts`
   - Be careful with memory and time — run on a staging copy or in small batches against production if necessary; verify results before finalizing the migration.

4. **Create performant index**
   - After backfill, create an IVFFLAT or HNSW index appropriate to your workload. Example:

     ```sql
     CREATE INDEX openmemory_vectors_vvector_idx ON openmemory_vectors USING ivfflat (v_vector vector_l2_ops) WITH (lists = 100);
     ```

   - Tune `lists` parameter and index type based on QPS/accuracy trade-offs.

5. **Application rollout**
   - The backend already detects the presence of `v_vector` and prefers DB-side search when available (see `PostgresVectorStore.init()` and `searchSimilar()`).
   - Deploy backend to a small canary (staging) environment and validate search results compared to in-memory fallback.

6. **Monitoring and rollback**
   - Monitor query latencies and result quality.
   - Keep `v` bytea data until confident; back out the index/column creation if needed.

7. **Cleanup**
   - Once stable, consider dropping `v` or keeping for archival. Update docs and add a migration to drop `v` if desired.

Notes & Caveats

- Index creation may require setting vector dimensions in the DB or creating the column with explicit dimension. If the IVFFLAT index creation fails complaining about missing dimensions, check your pgvector version and set vector column dimension accordingly.
- The `tools/backfill_pgvector.ts` script constructs a vector literal string from binary; review the precision and ensure the target `pgvector` type accepts the format used.
- Testing on a representative dataset is essential before enabling DB-side search in production.

What's changed (automation and safety checks)

- The `20240108000000_pgvector_finalize.sql` migration now performs additional checks and will print NOTICEs to guide operators:
  - It checks the column typmod (dimension) and warns if no explicit dimension is present.
  - It checks for rows where `v` (bytea) is present but `v_vector` is NULL and raises a notice recommending running `tools/backfill_pgvector.ts` to populate `v_vector` before finalizing.
  - The migration will attempt to create the IVFFLAT index but will continue gracefully if the column or index is not yet ready, avoiding hard failures during automated runs.

These improvements aim to make the migration observable, idempotent, and safer to run in automated CI or Supabase migration pipelines.

Rollback plan

- Restore the DB from backup, or
- Drop `v_vector` column and indexes and continue to use application bytea-based fallback (the app falls back to in-memory similarity if pgvector is unavailable).

References

- <https://github.com/pgvector/pgvector>
- Supabase docs: Vector (pgvector) support and indexing
