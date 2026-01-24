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
*   **Security**: When deleting files in test cleanup, use `Bun.spawn(["rm", filePath])` or `await Bun.write(filePath, "")` followed by `Bun.spawn(["rm", filePath])` for cross-platform compatibility.

### 1.2 The "Pydantic V2" Rule (Python)
For `packages/openmemory-py`, strict adherence to Pydantic V2 is required.
*   ✅ **Use**: `model_config = ConfigDict(arbitrary_types_allowed=True)` for complex types.
*   ✅ **Use**: `asyncio` and `pytest-asyncio` for all testing.
*   ❌ **Avoid**: Mixing sync/async tests without `pytest.mark.asyncio`.

### 1.3 Zero Regression
*   **Run Omnibus Tests**: Before marking a task done, run the full suite (`bun test`).
*   **Fix Lints**: Do not suppress lint errors. Fix them.
*   **Type Check**: `bun run typecheck` is mandatory.
*   **Validate Changes**: Use `getDiagnostics` tool to check for compile/lint/type issues after edits.

---

## 2. Project Architecture

### 2.1 Monorepo Structure
*   `packages/openmemory-js`: **Primary** Backend & JS SDK. (TypeScript/Bun)
*   `packages/openmemory-py`: Python SDK & Bridge. (Python 3.14+)
*   `apps/dashboard`: Next.js dashboard application
*   `apps/vscode-extension`: VSCode extension for IDE integration

### 2.2 JS/TS Source Map (`packages/openmemory-js/src`)
*   `ai/`: LLM & Graph logic, MCP tools, context management.
*   `core/`: **Core System** modules.
    *   `cfg.ts`: **Single Source of Truth** for Env. (Wraps `Bun.env` with Zod).
    *   `db.ts` & `db_access.ts`: SQLite/PG connection & transaction management.
    *   `repository/`: Repository pattern for data access (memory, temporal, users, etc.).
    *   `types/`: TypeScript type definitions.
    *   `vector/`: Vector store management and operations.
*   `memory/`: **HSG Engine** (Hierarchical Sectored Graph).
    *   `embed.ts`: Embedding logic with multi-provider support.
    *   `hsg.ts`: Core HSG implementation with memory operations.
    *   `utils.ts`: Memory utilities and helper functions.
*   `ops/`: **Operations** & Ingestion pipelines.
    *   `extract.ts`: File parsers (PDF, DOCX, Video). **Heavily relies on Bun Native I/O**.
    *   `ingest.ts`: Content ingestion and processing.
*   `server/`: API Server (**ElysiaJS**).
    *   `routes/`: API endpoint definitions.
    *   `middleware/`: Authentication, CORS, rate limiting.
*   `temporal_graph/`: Time-aware knowledge graph repository.
*   `sources/`: External data source connectors (GitHub, Google Drive, etc.).
*   `clients/`: Client libraries for different functionalities.

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
| **File Exists** | `Bun.file` | `if (await Bun.file("path").exists()) ...` |
| **Server** | **ElysiaJS** | Use `new Elysia()` context patterns. |
| **Database** | Repository Pattern | Use `q.memories.get()`, `q.temporal.insertFact()` etc. |

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
*   If changing schema, update type definitions in `src/core/types/` to match.

### 4.3 Testing Guidelines
*   **Mocks**: Use `bun:test` mocks. see `test/setup.ts`.
*   **Cleanup**: Tests must clean up their own SQLite files.
*   **Snapshots**: Minimize snapshot usage; prefer explicit assertions.
*   **Integration Tests**: Located in `test/integration/` with comprehensive coverage.

### 4.4 Code Quality Standards
*   **Zod Schema Safety**: Use `schema.innerType().shape` instead of accessing `_def` internals.
*   **SQL Injection Prevention**: Always escape LIKE wildcards using consistent escape characters.
*   **Vector Normalization**: Ensure all vector operations return normalized outputs.
*   **Error Handling**: Validate numeric inputs with `Number.isFinite()` before processing.
*   **Unused Imports**: Remove all unused imports to pass linting.

---

## 5. Agent Workflow

1.  **Read Context**: Before making changes, read `Agents.md` (this file) and `ARCHITECTURE.md`.
2.  **Plan**: If refactoring > 5 files, create/update `implementation_plan.md`.
3.  **Execute**:
    *   Apply changes using Bun patterns.
    *   **Verify** frequently with `bun test <file>`.
    *   Use `getDiagnostics` tool to check for issues.
4.  **Finalize**:
    *   Run `bun run typecheck`.
    *   Run full `bun test`.
    *   Update documentation if needed.

---

## 6. Known "Gotchas"

### 6.1 Bun vs Node.js APIs
*   **`Bun.file(path)` vs `fs.createReadStream`**: OpenAI SDK sometimes demands a Node stream.
    *   *Solution*: Pass `await Bun.file(path)` directly if supported (it mostly is now), or cast to `any` if TypeScript complains (verified working).
*   **File Deletion**: Use `Bun.spawn(["rm", filePath])` for test cleanup on Unix systems, or `Bun.spawn(["del", filePath])` on Windows. For cross-platform compatibility, check the platform and use appropriate commands.

### 6.2 Database & Repository Pattern
*   **Circular Imports**: Common in `core/` vs `memory/`. Use strict interface separation.
*   **Repository Access**: Use the `q` facade (`q.memories.get()`) instead of direct database calls.
*   **SQL Escaping**: Always escape LIKE patterns to prevent injection and ensure consistent behavior.

### 6.3 Memory & Performance
*   **OOM during Test**: If `bun test` crashes, run specific test files rather than the whole suite.
*   **Vector Operations**: Ensure all vector functions return normalized arrays.
*   **Zod Schema Access**: Use public APIs (`innerType()`) instead of private `_def` properties.

### 6.4 Type Safety & Validation
*   **Numeric Validation**: Always check `Number.isFinite()` for user inputs before mathematical operations.
*   **Destructuring**: When extracting properties, use the extracted values consistently (avoid referencing original object).
*   **API Responses**: Access correct response properties (e.g., `res.factsUpdated` not `res` directly).

---

## 7. Multi-App Architecture

### 7.1 Dashboard App (`apps/dashboard`)
*   **Framework**: Next.js 14+ with App Router
*   **Styling**: Tailwind CSS
*   **Components**: React components in `src/components/`
*   **API Integration**: Uses OpenMemory JS client

### 7.2 VSCode Extension (`apps/vscode-extension`)
*   **Framework**: VSCode Extension API
*   **Language**: TypeScript
*   **Features**: Memory integration, IDE event detection
*   **Writers**: Support for multiple AI providers (Claude, Cursor, etc.)

---

## 8. Security & Best Practices

### 8.1 Input Validation
*   **SQL Injection**: Use parameterized queries and escape LIKE patterns.
*   **XSS Prevention**: Sanitize user inputs in web interfaces.
*   **File Upload**: Validate file types and sizes during ingestion.

### 8.2 Authentication & Authorization
*   **API Keys**: Support for admin and user-level keys.
*   **Multi-tenancy**: User isolation via `user_id` across all operations.
*   **Context Management**: Proper user context propagation through request lifecycle.

### 8.3 Error Handling
*   **Graceful Degradation**: Handle embedding failures with fallbacks.
*   **Transaction Safety**: Wrap multi-step operations in database transactions.
*   **Logging**: Use structured logging with appropriate log levels.

---

## 9. Performance Optimization

### 9.1 Database
*   **Indexing**: Proper indices on frequently queried columns.
*   **Connection Pooling**: Efficient database connection management.
*   **Query Optimization**: Use repository pattern for optimized queries.

### 9.2 Vector Operations
*   **Batch Processing**: Process embeddings in batches when possible.
*   **Caching**: Cache frequently accessed vectors and computations.
*   **Normalization**: Ensure consistent vector normalization for accurate similarity.

### 9.3 Memory Management
*   **Cleanup**: Proper cleanup of test databases and temporary files.
*   **Resource Limits**: Configure appropriate memory limits for TypeScript compilation.

---

*Last Updated: 2026-01-21*
