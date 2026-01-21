# Database Migrations in OpenMemory

OpenMemory uses a built-in migration system to manage schema changes across SQLite and PostgreSQL.

## Migration Principles

- **Local Execution**: Migrations can only be run from the local CLI, never against a remote cluster directly via API (for security).
- **Distributed Locking**: Only one node in a cluster can run migrations at a time. The system uses a `system:migrations` lock.
- **Backups**: For SQLite, the system automatically creates a timestamped backup of the database file in the `backups/` directory before starting migrations.
- **Transactions**: Each migration is executed within a transaction. If any part of a migration fails, the entire migration (and subsequent ones) is rolled back.

## Running Migrations

To run pending migrations:

```bash
bun src/cli.ts migrate
```

## Creating a New Migration

Migrations are defined in `src/core/migrate.ts`. To add a new one:

1.  Increment the version (e.g., `1.12.0`).
2.  Add a description.
3.  Define the SQL for both PostgreSQL and SQLite.

### Template

```typescript
{
    version: "1.12.0",
    description: "Your description here",
    pg: `
        ALTER TABLE {m} ADD COLUMN IF NOT EXISTS new_col text;
    `,
    sqlite: `
        ALTER TABLE memories ADD COLUMN new_col text;
    `
}
```

> [!NOTE]
> Use `{m}`, `{v}`, `{u}`, etc. placeholders in PostgreSQL migrations to support dynamic table names/schemas. SQLite migrations should use standard table names (e.g., `memories`).

## Troubleshooting

### Migration Lock Timeout
The migration lock has a **30-second timeout**. If another node is hanging or crashed while holding the lock, you may need to wait or manually clear the lock from the `system_locks` table.

### Failed Migrations
If a migration fails, check the logs for the specific SQL error. Since migrations are transactional, your database should remain in a consistent state (the version before the failed migration).
