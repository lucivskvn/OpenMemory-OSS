# Transaction Handling in OpenMemory

OpenMemory provides a unified transactional API that works across both SQLite and PostgreSQL backends. This document outlines how to use transactions, how nesting works, and the safety measures in place.

## Basic Usage

The `transaction.run` helper is the primary way to execute code within a transaction.

```typescript
import { transaction, q } from "./core/db";

await transaction.run(async () => {
    await q.insMem.run({ ... });
    await q.updStats.run({ ... });
});
```

If the provided function throws an error, the transaction is automatically rolled back.

## Nested Transactions

OpenMemory supports nested transactions using **SAVEPOINTs**. If `transaction.run` is called while another transaction is already active, it will create a savepoint rather than a new top-level transaction.

### Example

```typescript
await transaction.run(async () => {
    // Top-level BEGIN
    await innerOperation();
    // Top-level COMMIT
});

async function innerOperation() {
    await transaction.run(async () => {
        // SAVEPOINT sp_123
        // If this throws, it rolls back to the savepoint
        // without affecting the rest of the outer transaction
    });
}
```

## Safety Measures

### 1. Transaction Timeout
All transactions have a default timeout of **30 seconds**. If the logic inside `transaction.run` takes longer than this, the transaction will be automatically rejected and rolled back to prevent deadlocks and connection pool exhaustion.

### 2. Immediate Transactions (SQLite)
In SQLite, we use `BEGIN IMMEDIATE` to prevent "database is locked" errors during write-heavy workloads. This ensures that the transaction acquires a write lock at the start.

### 3. Serialization
To prevent race conditions during initialization, `init()` and `getVectorStore()` calls are serialized.

### 4. Connection Pool
PostgreSQL connections are managed via a pool with configurable limits (`PG_MAX_CONNECTIONS`, `PG_IDLE_TIMEOUT`, `PG_CONN_TIMEOUT`).

## Best Practices

- **Keep transactions short**: Avoid long-running async tasks (like LLM calls or large network requests) inside a transaction.
- **Handle Rollbacks**: Always be prepared for a transaction to fail and ensure your application logic can handle the resulting error.
- **Nested Reliability**: Use nested transactions for sub-operations that might fail but shouldn't necessarily fail the entire operation.
