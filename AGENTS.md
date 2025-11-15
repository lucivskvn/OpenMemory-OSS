# AGENTS — Instructions for automated coding agents

This file gives focused, actionable guidance for AI agents working on OpenMemory. It complements `.github/copilot-instructions.md` by describing agent roles, the exact inputs we expect, common tasks, and the most important files and workflows to touch.

## Quick human summary

- Agent roles:
  - Info-gatherer: inspect code, tests, and config; produce a short summary and minimal next steps.
  - Code-synthesizer: implement requested changes (small feature/bugfix), add tests, and run focused validation.
  - Reviewer / PR author: prepare PR description, list modified files, and follow-up manual checks.
  - Release/ops assistant: prepare changelogs, bump versions, and ensure build/test steps are included.

## Bun-first addendum

When working on backend TypeScript code prefer Bun-native tooling and conventions:

- Prefer Bun v1.3.2+ for runtime and CI.
- Use `Bun.file()` for large file operations and `Bun.password` helpers for hashing where applicable.
- Add `@types/bun` to `devDependencies` and include Bun typings in `tsconfig.json` when adding Bun-specific types.

See `CONTRIBUTING.md` for developer setup and Bun guidance.

## Machine-readable instruction schema

Agents accept a single JSON/YAML instruction payload with the following schema. This standardizes requests and outputs for automated workflows.

```json
{
  "type": "object",
  "properties": {
    "id": {"type": "string"},
    "goal": {"type": "string"},
    "files": {"type": "array", "items": {"type": "string"}},
    "constraints": {"type": "array", "items": {"type": "string"}},
    "tests": {"type": "array", "items": {"type": "string"}},
    "priority": {"type": "string", "enum": ["low","medium","high"]},
    "dry_run": {"type": "boolean"}
  },
  "required": ["id","goal"]
}
```

Minimum fields:

- `id`: unique short id for the request
- `goal`: one-line description of the requested change

Optional fields:

- `files`, `constraints`, `tests`, `priority`, `dry_run`

## Expected outputs

- `status`: one of ["accepted","in_progress","completed","blocked","rejected"]
- `patch`: unified diff/patch text (if applicable)
- `summary`: short human-readable summary
- `tests`: map of test name -> {status, output}
- `artifacts`: list of created files or PR URL
- `security_scan`: object summarizing automated security findings. Example schema:
  - `summary`: short string
  - `findings`: array of { `id`: string, `description`: string, `severity`: "low|medium|high|critical", `file?`: string }
  - `recommendations`: array of short remediation strings
- `performance_impact`: object with estimated runtime and resource impact. Example schema:
  - `cpu_ms?`: number  # estimated CPU time in milliseconds
  - `mem_mb?`: number  # estimated memory impact in megabytes
  - `notes?`: string   # human-readable notes about perf tradeoffs

## Agent action contract (concise)

1. Validate the input payload. If required fields are missing, return `status: rejected` with a validation error.
2. Run a fast repo scan of the listed `files` (or repo root if omitted) to collect context.
3. Produce a short plan (3–6 steps) describing edits, tests, and verification commands.
4. Implement the smallest change to satisfy the goal, adding focused unit tests where feasible.
5. Run the specified tests and a local build (`bun run build` for TypeScript changes).
6. Return a structured result and, if `dry_run` is false, apply the patch or open a PR as configured.

## Exit criteria & safety checks

- Never commit secrets. If secrets are found, abort and report.
- For DB schema changes: update `backend/src/migrate.ts` and include migration tests.
- For public API changes: add a changelog entry and request human review.

## Quick commands

```bash
# Backend development
cd backend && bun install --frozen-lockfile && bun run dev

# Run migrations
cd backend && bun run migrate

# Build
cd backend && bun run build

# Tests
bun test  # run from backend/
```

## Files & hot spots to inspect first

- `backend/src/server/index.ts` — server entry and background tasks
- `backend/src/migrate.ts` — DB migrations
- `backend/src/memory/` — HSG/reflect/user_summary logic
- `backend/src/ai/` — MCP / embeddings integration

## Bun tips for agents

- Use `Bun.file()` when reading or streaming large files. It's faster and uses less memory than reading into a single Buffer.
- Convert `ArrayBuffer`/TypedArray to `Buffer` only when necessary: `Buffer.from(await Bun.file(path).arrayBuffer())`.
- When writing tests that need Bun-only features, ensure the test runner is Bun (`bun test`) and avoid Node-specific globals unless polyfilled.

Last updated: 2025-11-13

Maintainers / contact: ping a human reviewer (e.g., `@maintainer-handle`) for big changes.

## Example agent task (dependency pinning)

- Goal: "Pin @xenova/transformers and update lockfile"
- Description: Edit `backend/package.json` to pin `@xenova/transformers` to a stable semver (e.g., `^2.17.2`), run `bun install` to update `bun.lockb`, and verify tests pass locally. Add a CHANGELOG entry and update CI to use `--frozen-lockfile`.

## Bun Native API Examples

The repo uses Bun-native APIs in several backend hotspots. Below are quick examples and cross-references to code that uses these APIs.

- **File I/O (large files)**: use `Bun.file()` for streaming and to access `.size` efficiently. See `backend/src/ops/extract.ts` for canonical usage and sanity checks when handling `application/octet-stream`.

- **Password / hashing helpers**: prefer `Bun.password` helpers where available for deterministic test-friendly hashes; see `backend/src/core/db.ts` for integration points and `backend/src/server/middleware/auth.ts` for how hashed keys are validated.

- **Server lifecycle**: Bun's fast runtime is used in `backend/src/server/server.ts` / `backend/src/server/index.ts`; agents should prefer the server's programmatic start/stop helpers when writing integration tests to avoid binding port conflicts.

- **Example snippet (reading a file safely)**:

```ts
// stream a large file with Bun.file()
const f = Bun.file('/path/to/large.bin');
const size = typeof f.size === 'function' ? await f.size() : f.size;
const buf = await f.arrayBuffer();
// pass `buf` to existing extract helpers
```

## MCP Integration Patterns

When integrating with the MCP (Model Context Protocol) transport, follow these patterns for reliability and testability:

- **Transport lifecycle**: start the MCP transport in a controlled manner from `backend/src/server/server.ts` and expose programmatic start/stop helpers used by tests. Ensure transports reconnect with exponential backoff and emit clear logs for connection state changes.

- **Idempotent handlers**: design handlers to be idempotent where possible (retries may occur). Persisting side-effects should use upserts or dedup keys; see `backend/src/core/db.ts` for examples of `insert or replace` patterns.

- **Batching & backpressure**: batch outgoing embedding or reflection requests and respect provider rate limits. Use background workers that checkpoint progress so retries continue from the last checkpoint.

- **Error handling & observability**: return structured error objects to the MCP transport and record metrics (counts, latency). Include a short `context` blob in failures so downstream agents can triage without full logs.

- **Example pattern (request/response)**:

1. Validate incoming MCP payload quickly and synchronously.
2. Enqueue heavy work (embedding, file-extract) to a background worker and immediately ack if protocol allows.
3. Persist task id and respond with a reference; provide a callback/webhook pattern for the agent to retrieve results.

See `backend/src/ai/mcp.ts` (MCP helpers) and `backend/src/ops/extract.ts` (heavy work examples) for concrete patterns and helper utilities.

- **Ollama management endpoints for agents**: Use `/embed/ollama/pull`, `/embed/ollama/list`, `/embed/ollama/delete`, and `/embed/ollama/status` as MCP-friendly orchestration surfaces. These endpoints support `mcp_task_id` for task correlation and include a `context` object in responses containing `task_id`, `model`, `requested_at`, and error details for reliable agent workflows in Linear/GitHub integrations.
