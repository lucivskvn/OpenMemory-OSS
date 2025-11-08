## Purpose

This file gives concise, actionable context to help an AI coding agent (or a new contributor) get productive in the OpenMemory codebase quickly.

Read this before making changes that touch the backend, DB layer, or runtime. It focuses on concrete patterns, file locations, and commands discovered in the repository.

---

## Big picture (quick)

- Backend: TypeScript, Bun-first runtime. Main server lives in `backend/src/server/index.ts` and the core DB abstraction is `backend/src/core/db.ts`.
- Frontend: Next.js dashboard in `dashboard/` (talks to backend via HTTP). SDKs live in `sdk-js/` and `py-sdk/`.
- Storage: SQLite (default) or PostgreSQL. The backend uses a centralized `q` DB API (see `backend/src/core/db.ts`) to encapsulate all SQL and prepared statements.
- Protocols: HTTP REST + MCP (Model Context Protocol) at `backend/src/ai/mcp.ts`.

Why this matters: most bugs and security issues stem from bypassing `q.*` helpers (raw SQL) or forgetting tenant scoping (`user_id`). Prefer changing `q.*` and its implementations rather than scattering SQL changes across routes.

---

## Key project-specific conventions (do these)

- Bun-first: use Bun commands from `backend/package.json` when possible. Example dev/start/typecheck commands live there.
- Central DB surface: use the `q` object in `backend/src/core/db.ts` for all DB access. Do not write raw SQL in route handlers if a `q` helper exists. If you must add SQL, add it as a new `q` helper and update both PG and SQLite branches.
- Tenant scoping: every mutable operation and most read operations accept a `user_id`. Many APIs require passing `user_id` explicitly (example: deletion).
  - Example: await q.del_mem.run(memoryId, userId)
  - Example: const count = await q.count_memories.get(userId) // or `.all(userId)` depending on helper
- SQLite prepared statements use `?` placeholders and sometimes duplicate `user_id` when SQL contains `( ? is null or user_id = ? )`. The SQLite wrapper in `backend/src/core/db.ts` duplicates parameters in the mapping layer — follow that pattern.
- DB timing/logging: enabled by env var `OM_LOG_DB`. Wrappers in `db.ts` emit timing when set.
- Transactions: PostgreSQL uses client-level transactions; SQLite now issues explicit `BEGIN`/`COMMIT`/`ROLLBACK` in the DB abstraction. Use the `transaction` helpers exported by `q` when doing multi-statement updates.

---

## Development & common commands

From repository root, most backend work happens in `/backend`:

- Start dev server (hot reload, Bun):

  cd backend
  OM_TIER=hybrid bun --hot src/server/index.ts

- Build (emit a Bun-targeted app to `dist`):

  cd backend
  bun build src/server/index.ts --target=bun --outdir=dist

- Start compiled server:

  cd backend
  bun dist/server/index.js

- Run migrations:

  cd backend
  bun run src/migrate.ts

- Type-check:

  cd backend
  bun tsc --noEmit

Notes:
- The code imports the Bun builtin `bun:sqlite`. Running under plain Node requires a compatibility shim (the repo contained a temporary shim for local debugging). Prefer running under Bun in CI and local development to avoid subtle differences.

Bun migration note:
- This repository is Bun-first. Aim to run dev, build, test, and CI under Bun. Avoid introducing or committing Node-only shims (for example, `node_modules/bun:sqlite`). If you need a temporary Node shim for local debugging, keep it out of commits and document its presence.
- CI should use Bun images/runners and `bun install` to produce/consume `bun.lockb`. If a lockfile policy is chosen, commit `backend/bun.lockb` and re-enable `--frozen-lockfile` in Dockerfile/CI.

---

## Where to look for common change points

- DB core and helpers: `backend/src/core/db.ts` (read this before changing DB behavior)
- Router handlers: `backend/src/server/routes/*.ts` (memory, users, dashboard, system)
- Background jobs: `backend/src/memory/` and `backend/src/ops/` (decay, dynamics, ingest)
- MCP/AI entrypoints: `backend/src/ai/mcp.ts` and `backend/src/ai/graph.ts`
- Tests and integration scripts: `tests/backend/` (useful examples of API usage and tenant isolation tests)
- Docker/infra: `docker-compose.yml`, `backend/Dockerfile`, `podman/openmemory.container`

---

## Patterns & examples (copy these exactly)

- Use `q` helpers, not raw SQL in routes. Example deletion flow in handlers:

  // delete all memories for a user
  const r = await q.del_mem.run(memoryId, userId)
  await q.del_vec.run(memoryId, userId)
  await q.del_waypoints.run(memoryId, userId)

- Insert/upsert vectors and summaries via `q.ins_vec.run(...)` and `q.upd_summary.run(...)` in background jobs.

- DB timing: set `OM_LOG_DB=1` in your environment to get query timings in logs when debugging slow queries.

---

## Integration points & gotchas

- Bun builtin `bun:sqlite` is used by the production/normal runtime. If tests are executed under Node, the runtime will fail to `import 'bun:sqlite'` unless a compatibility layer like `better-sqlite3` is provided.
- Many prepared statements for SQLite use conditional tenant placeholders `( ? is null or user_id = ? )`. When adding new helpers, follow the sqlite mapping pattern used in `db.ts` to duplicate `user_id` parameters as needed.
- MCP tool names use underscores (see `backend/src/ai/mcp.ts`) — watch for name mismatches if you edit or extend MCP handlers.

---

## Quick checklist before PR

1. Did you add or change SQL? If yes, add/update a `q.*` helper in `backend/src/core/db.ts` and implement both PG and SQLite branches.
2. Are user-scoped operations properly passing `user_id`? Confirm route tests in `tests/backend/` or add a small integration test.
3. Run `bun tsc --noEmit` in `backend` and run the relevant tests. Prefer running under Bun to avoid `bun:sqlite` shims.
4. If you changed Docker/Bun lockfile behavior, update `backend/Dockerfile` and CI accordingly.

---

If anything here is unclear or you'd like me to expand a section (for example: exact signatures for the most-used `q.*` helpers), tell me which area and I'll iterate.
