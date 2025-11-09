
# Per-user stats tests

These tests validate the tenant-scoped `stats` helpers in the backend DB layer.

Run locally from the `backend/` directory:

```bash
OM_TESTING=1 OM_DB_PATH=':memory:' bun test ../tests/backend --max-concurrency=1
```

Files:

- `per_user_stats.test.js` - verifies per-user row counts and totals.
- `per_user_stats_null.test.js` - verifies that `null` user_id yields global results.

Notes:

- Tests start the backend server in-process using the existing `_ensure_server.js` harness.

- The tests are lightweight and intentionally use the in-memory SQLite DB (fast and isolated).
