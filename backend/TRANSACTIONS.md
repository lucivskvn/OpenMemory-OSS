Short guide: when to use withTransaction vs direct transaction handlers

Overview
--------

This project exposes two ways to work with transactions in the backend:

- withTransaction(fn): a convenience helper that begins a transaction (or savepoint), runs
  the provided async function, commits if it completes, and rolls back if it throws.
- transaction.begin/commit/rollback: the low-level handlers. These are used when tests
  or specific code paths need explicit nested savepoint control.

When to use withTransaction
---------------------------

- Typical application code should prefer `withTransaction` for short atomic units of work
  (insert memory + vectors, small multi-statement flows, etc.). It reduces boilerplate and
  ensures consistent commit/rollback semantics across SQLite and Postgres backends.
- Example (commit):

```ts
await withTransaction(async () => {
  await q.ins_stat.run('reflect', 1, Date.now())
})
```

- Example (rollback): throwing inside the function will rollback:

```ts
try {
  await withTransaction(async () => {
    await q.ins_stat.run('tmp', 1, Date.now())
    throw new Error('force rollback')
  })
} catch (e) {
  // work rolled back
}
```

When to use `transaction` directly
----------------------------------

- Use the low-level `transaction.begin/commit/rollback` when you need explicit nested
  savepoint control or when a test needs to assert savepoint semantics (see
  `tests/backend/nested-transaction.test.js`).
- Do NOT monkey-patch or override the underlying database's `transaction` method. The
  codebase intentionally avoids modifying prototypes to keep behavior consistent and

  # Transactions — withTransaction vs direct transaction handlers

  Overview
  --------

  This project exposes two ways to work with transactions in the backend:

  - withTransaction(fn): a convenience helper that begins a transaction (or savepoint), runs
    the provided async function, commits if it completes, and rolls back if it throws.
  - transaction.begin/commit/rollback: the low-level handlers. These are used when tests
    or specific code paths need explicit nested savepoint control.

  When to use withTransaction
  ---------------------------

  Typical application code should prefer `withTransaction` for short atomic units of work
  (insert memory + vectors, small multi-statement flows, etc.). It reduces boilerplate and
  ensures consistent commit/rollback semantics across SQLite and Postgres backends.

  Example (commit)

  ```ts
  await withTransaction(async () => {
    await q.ins_stat.run('example', 1, Date.now())
  })
  ```

  Example (rollback)

  Throwing inside the function will rollback:

  ```ts
  try {
    await withTransaction(async () => {
      await q.ins_stat.run('will_roll', 1, Date.now())
      throw new Error('force rollback')
    })
  } catch (e) {
    // the 'will_roll' stat is not committed
  }
  ```

  When to use `transaction` directly
  ----------------------------------

  Use the low-level `transaction.begin/commit/rollback` when you need explicit nested
  savepoint control or when a test needs to assert savepoint semantics (see
  `tests/backend/nested-transaction.test.js`).

  Do NOT monkey-patch or override the underlying database's `transaction` method. The
  codebase intentionally avoids modifying prototypes to keep behavior consistent and

  # Transactions — withTransaction vs direct transaction handlers

  ## Overview

  This project exposes two ways to work with transactions in the backend:

  - `withTransaction(fn)`: a convenience helper that begins a transaction (or savepoint),
    runs the provided async function, commits if it completes, and rolls back if it throws.
  - `transaction.begin` / `transaction.commit` / `transaction.rollback`: the low-level
    handlers. Use these only when you need explicit nested savepoint control or for tests
    that assert savepoint semantics.

  ## When to use withTransaction

  Prefer `withTransaction` for typical application code that performs a short atomic unit of
  work (for example: insert memory + vectors, update several rows that must succeed
  together). It reduces boilerplate and ensures consistent commit/rollback behavior across
  SQLite and Postgres backends.

  Example (commit):

  ```ts
  await withTransaction(async () => {
    await q.ins_stat.run('example', 1, Date.now())
  })
  ```

  Example (rollback):

  ```ts
  try {
    await withTransaction(async () => {
      await q.ins_stat.run('will_roll', 1, Date.now())
      throw new Error('force rollback')
    })
  } catch (e) {
    // work rolled back
  }
  ```

  ## When to use `transaction` directly

  Use the direct `transaction` handlers when you need manual control over nested
  savepoints (for example, in tests that assert nested savepoint behavior, see
  `tests/backend/nested-transaction.test.js`). Avoid overriding or monkey-patching the
  database prototype—this repository intentionally keeps the Database prototype untouched.

  ## Generated files

  Compiled outputs under `dist/` (or other build artifacts) may contain `transaction` calls
  because they are a result of compilation from source. Those generated files should be
  ignored for manual edits—the source under `backend/src/` and `tests/` is the place to
  apply changes.

  ## Quick checklist for PRs

  - Prefer `withTransaction` for short atomic workflows.
  - Reserve `transaction` for explicit nested-savepoint needs or test assertions.
  - Add/update tests when modifying transactional behavior.

  If unsure, ping a reviewer to confirm the desired commit/rollback semantics on both
  SQLite and Postgres.
