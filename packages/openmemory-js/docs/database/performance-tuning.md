# Database Performance Tuning

This guide covers performance optimizations and configuration settings for the OpenMemory database layer.

## Indexing Strategy

OpenMemory includes several out-of-the-box indices for common queries:

- **Core Search**: `idx_mem_user`, `idx_mem_sector`
- **Temporal/Graph**: `idx_te_src`, `idx_te_tgt`, `idx_te_full`
- **Optimization**:
    - `user_id + created_at DESC`: Fast retrieval of recent memories.
    - `user_id + salience DESC`: Efficient retrieval for memory ranking.
    - `user_id + last_seen_at DESC`: For "recently seen" optimizations.
- **Vector Search**: HNSW index (PostgreSQL with `pgvector`).

## PostgreSQL Pool Configuration

Tune these in your `.env` file for heavy workloads:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PG_MAX_CONNECTIONS` | Max concurrent connections in the pool | `20` |
| `PG_IDLE_TIMEOUT` | Time (ms) to keep idle connections alive | `30000` |
| `PG_CONN_TIMEOUT` | Time (ms) to wait for a connection | `2000` |

## SQLite Optimizations

OpenMemory automatically applies several SQLite performance settings:

1.  **WAL Mode**: Enables `PRAGMA journal_mode=WAL` for better concurrency (writers don't block readers).
2.  **Synchronous NORMAL**: Sets `PRAGMA synchronous=NORMAL` to improve write performance while maintaining safety in most scenarios.
3.  **Statement Cache**: Up to 100 prepared statements are cached per connection with LRU eviction.

## Slow Query Logging

Query performance is monitored. Any query taking longer than **1 second** is logged with a warning:

```json
{"level":"warn","message":"[DB] Slow query (>1s)","sql":"...","duration":1250}
```

## Best Practices

- **Avoid SELECT \***: Use specific columns where possible to reduce payload size.
- **Filter by user_id**: Always include a `user_id` filter to utilize composite indices.
- **Batch Inserts**: Use `insMems` or `insWaypoints` for bulk operations to minimize transaction overhead.
- **Monitor Statement Cache**: If you see high "Preparing statement" logs, consider increasing the LRU cache limit in `db.ts`.
