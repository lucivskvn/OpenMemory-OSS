# Supabase & Postgres Migrations (Optional)

These files are **optional** and intended only for deployments that opt-in to a Postgres backend (for example to use `pgvector` for DB-side vector similarity).

Important notes:

- OpenMemory defaults to **SQLite**. You do **not** need Supabase to run the app locally or in production unless you intentionally opt-in.
- The migration SQL files in this folder are Postgres-specific and should only be applied against a Postgres database.
- If you run Supabase locally with `supabase start`, ensure the ports used by the Supabase containers are free (the CLI defaults can conflict with other services). You can set a different db port via `supabase/config.toml` for local debugging.
- The `pgvector` migration and backfill tools are documented in `docs/PGVECTOR_MIGRATION.md` and are safe to run only after careful backups.

CI / Automation guidance:

- Do **not** run these migrations in CI by default. If you want to automate Postgres migrations, add a guarded job that runs only when `OM_METADATA_BACKEND=postgres` or when the repository maintainer explicitly enables the migration workflow.

If you need help checking or running these migrations locally, I can:

- Run the Supabase CLI locally and inspect migrations (note: requires available ports and Docker).
- Add a guarded CI job to validate Postgres migrations only when explicitly enabled.

