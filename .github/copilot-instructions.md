<!-- copilot-instructions: concise, actionable guidance for AI coding agents -->
# OpenMemory — Copilot / AI Agent Instructions

Purpose
- Help an AI agent become productive quickly: architecture overview, key workflows, conventions, and integration points.

Quick architecture (big picture)
- Backend: TypeScript Node service in `backend/` (entry: `backend/src/server/index.ts`). Handles HTTP API, WebSocket, decay/reflection background jobs and MCP integration.
- Dashboard: Next.js app in `dashboard/` serving the UI (`dashboard/app/` and `dashboard/page.tsx`).
- Persistence: metadata and vectors live in SQLite by default (`data/openmemory.sqlite`) or Postgres (configured via env). Migrations live in `backend/src/migrate.ts`.
- SDKs: `sdk-js/` and `sdk-py/` provide client libraries and examples in `examples/`.

Essential workflows & commands (run these exactly)
- Backend development:
  - Install & run: `cd backend && npm install && npm run dev` (uses `tsx` to run TypeScript directly).
  - Build: `cd backend && npm run build` (runs `tsc -p tsconfig.json`).
  - Start (production): `cd backend && npm start` -> runs `node dist/server/index.js`.
  - Run DB migrations: `cd backend && npm run migrate` (executes `backend/src/migrate.ts`).
- Dashboard (frontend): `cd dashboard && npm install && npm run dev` / `npm run build` / `npm start`.
- Repo-level shortcuts: root `package.json` forwards to the backend: `npm run build` and `npm start` from repo root run backend equivalents.
- Docker: `docker-compose up --build` (see `docker-compose.yml` for many env variables, e.g. `OM_DB_PATH`).

Tests (exact commands)
- Backend integration tests are run as plain Node scripts (they expect a running server):
  1. Start the backend (dev or production build):
    ```bash
    cd backend
    npm run dev    # development (tsx)
    # or for a built server:
    npm run build
    npm start
    ```
  2. In another shell, run the test runner(s):
    ```bash
    # run a single test file
    node tests/backend/api.test.js

    # run other backend tests similarly, e.g.:
    node tests/backend/decay-reflection.test.js
    ```

Note: `backend/package.json` currently does not define a `test` script. Agents should run test files directly (node ...) or add a `test` script if they introduce a test runner.

Project-specific conventions & patterns
- TypeScript-first: prefer TS in backend; dev server uses `tsx` and build uses `tsc`.
- HSG concepts (Hybrid Sector Graph) are core domain terms — look for `memory/hsg`, `memory/reflect`, and `memory/user_summary` for logic affecting decay/waypoints.
- Background tasks are started from the server entry (`start_reflection`, `start_user_summary_reflection`, decay/prune setIntervals).
- Migration pattern: `backend/src/migrate.ts` runs idempotent `CREATE TABLE IF NOT EXISTS` SQL. Use or update this file for schema changes.
- Embeddings/providers: configuration through environment variables (OpenAI, Gemini, Ollama, local model). See `docker-compose.yml` for names (e.g. `OPENAI_API_KEY`, `OM_GEMINI_API_KEY`).

Integration points and things to watch
- Environment-driven behavior: many features toggle via env vars (e.g., `OM_METADATA_BACKEND`, `OM_VECTOR_BACKEND`, `OM_AUTO_REFLECT`, `OM_MODE`). Prefer reading `docker-compose.yml` and `backend/src/core/cfg` for defaults.
- DB backends: default is SQLite (fast local dev). Postgres is supported; migrations still use SQL in `migrate.ts` — verify compatibility when switching backends.
- CLI helper: `backend/bin/opm.js` exposes repository CLI commands — useful for running packaged utilities.
- Tests & fixtures: tests live in `tests/` (JS & Python). Some test fixtures include SQLite files (e.g., `tests/verify_tenant_*.sqlite`) — don't modify committed fixtures; ignore runtime WAL/SHM files.

How to make safe changes
- When changing DB schema: update `backend/src/migrate.ts` and add tests that run migrations against a temp DB. Avoid manual edits to `data/openmemory.sqlite` in repo.
- When adding endpoints: update `backend/src/server/routes` and `routes/dashboard` middleware; add SDK tests in `sdk-js` or `sdk-py` where appropriate.
- When adding a feature that affects embeddings or models: add config flags (env) and document them in `docker-compose.yml` and README.

Files & locations to reference quickly
- Server entry: `backend/src/server/index.ts`
- Migrations: `backend/src/migrate.ts`
- CLI: `backend/bin/opm.js`
- Frontend: `dashboard/` (Next.js)
- Data: `data/openmemory.sqlite`
- Docker config: `docker-compose.yml` and `backend/Dockerfile`
- SDKs: `sdk-js/`, `sdk-py/`, `examples/`

If something is unclear
- Ask for the specific goal (feature/bug/area). Point to a target file or the failing test when possible; e.g., "Change HSG waypoint decay in `backend/src/memory/hsg.ts`".

Done — ask me to iterate on any missing/unclear parts or to merge content from another agent doc you have.
