# OpenMemory Agent Guidelines

> [!IMPORTANT]
> **This is the supreme law of the repo.** All AI Agents must adhere strictly to these guidelines. Violations will result in broken builds, OOM errors, and rejected PRs.

## 1. Core Mandates

### 1.1 The "Bun Native" Rule (JS/TS)
For `packages/openmemory-js`, you **MUST** use Bun's native APIs.
*   ❌ **FORBIDDEN**: `import fs from 'node:fs'`, `child_process.spawn`.
*   ✅ **REQUIRED**: `Bun.file()`, `Bun.write()`, `Bun.spawn()`, `Bun.env`.
*   **Exception**: `node:fs` is permitted *only* if a strict dependency (like `openai` SDK or `legacy libs`) absolutely requires a `ReadStream` that `Bun.file` cannot satisfy (though `Bun.file` is now compatible with most things). If you must use `node:fs`, wrap it isolated in `src/utils` or a compatibility layer.
*   **Async First**: Bun's file I/O is optimized for async. Never use synchronous `readFileSync` or `statSync` in flow-critical paths.

### 1.2 The "Pydantic V2" Rule (Python)
For `packages/openmemory-py`, strict adherence to Pydantic V2 is required.
*   ✅ **Use**: `model_config = ConfigDict(arbitrary_types_allowed=True)` for complex types.
*   ✅ **Use**: `asyncio` and `pytest-asyncio` for all testing.
*   ❌ **Avoid**: Mixing sync/async tests without `pytest.mark.asyncio`.

### 1.3 Zero Regression
*   **Run Omnibus Tests**: Before marking a task done, run the full suite (`bun test`).
*   **Fix Lints**: Do not suppress lint errors. Fix them.
*   **Type Check**: `bun run typecheck` is mandatory.

---

## 2. Project Architecture

### 2.1 Monorepo Structure
*   `packages/openmemory-js`: **Primary** Backend & JS SDK. (TypeScript/Bun)
*   `packages/openmemory-py`: Python SDK & Bridge. (Python 3.14+)

### 2.2 JS/TS Source Map (`packages/openmemory-js/src`)
*   `ai/`: LLM & Graph logic (LangGraph helpers).
*   `core/`: **Core System** modules.
    *   `cfg.ts`: **Single Source of Truth** for Env. (Wraps `Bun.env` with Zod).
    *   `db.ts`: SQLite/PG connection & transaction management.
    *   `models.ts`: Model configuration & loading (Async default).
*   `memory/`: **HSG Engine** (Hierarchical Sectored Graph).
    *   `embed.ts`: Embedding logic.
    *   `classification.ts`: Input classification.
*   `ops/`: **Operations** & Ingestion pipelines.
    *   `extract.ts`: File parsers (PDF, DOCX, Video). **Heavily relies on Bun Native I/O**.
*   `server/`: API Server (**ElysiaJS**).
    *   *Note*: Migration from custom framework to Elysia is active. Use Elysia patterns for new routes.
*   `temporal_graph/`: Time-aware knowledge graph repository.

---

## 3. Development Stack & Cheatsheet

### JavaScript / TypeScript
| Category | Tool | Command / Pattern |
| :--- | :--- | :--- |
| **Runtime** | Bun 1.2+ | `bun run ...` |
| **Test Runner** | Bun Test | `bun test` |
| **Type Check** | TSC via Bun | `bun run typecheck` (Note: Uses `max-old-space-size`) |
| **Env Vars** | `Bun.env` | Access via `src/core/cfg.ts` only! |
| **File Read** | `Bun.file` | `const txt = await Bun.file("path").text()` |
| **File Write** | `Bun.write` | `await Bun.write("path", content)` |
| **File Write** | `Bun.write` | `await Bun.write("path", content)` |
| **File Exists** | `Bun.file` | `if (await Bun.file("path").exists()) ...` |
| **Server** | **ElysiaJS** | Use `new Elysia()` context patterns. |

### Python
| Category | Tool | Command / Pattern |
| :--- | :--- | :--- |
| **Manager** | Pip / Hatch | `pip install -e .[dev]` |
| **Testing** | Pytest | `pytest` / `pytest -m asyncio` |
| **Models** | Pydantic V2 | `class MyModel(BaseModel): ...` |

---

## 4. Operational Protocols

### 4.1 Memory Management (Typecheck)
The TypeScript compiler can consume massive memory on this project.
*   **Always** run typecheck with: `NODE_OPTIONS='--max-old-space-size=8192'`
*   The `package.json` script `typecheck` already includes this. Use `bun run typecheck`.

### 4.2 Database Migrations
*   Located in `src/core/migrate.ts`.
*   Ensure migrations are idempotent.
*   If changing schema, update `src/types/db.ts` to match.

### 4.3 Testing Guidelines
*   **Mocks**: Use `bun:test` mocks. see `tests/setup.ts`.
*   **Cleanup**: Tests must clean up their own SQLite files.
*   **Snapshots**: Minimize snapshot usage; prefer explicit assertions.

## 5. Agent Workflow

1.  **Read Context**: Before making changes, read `Agents.md` (this file) and `ARCHITECTURE.md`.
2.  **Plan**: If refactoring > 5 files, create/update `implementation_plan.md`.
3.  **Execute**:
    *   Apply changes using Bun patterns.
    *   **Verify** frequently with `bun test <file>`.
4.  **Finalize**:
    *   Run `bun run typecheck`.
    *   Run full `bun test`.
    *   Update `walkthrough.md`.

## 6. Known "Gotchas"
*   **`Bun.file(path)` vs `fs.createReadStream`**: OpenAI SDK sometimes demands a Node stream.
    *   *Solution*: Pass `await Bun.file(path)` directly if supported (it mostly is now), or cast to `any` if Typescript cries (verified working).
*   **Circular Imports**: Common in `core/` vs `memory/`. Use strict interface separation.
*   **OOM during Test**: If `bun test` crashes, run mostly relevant tests rather than the whole suite if debugging.

---
*Last Updated: 2026-01-19*
