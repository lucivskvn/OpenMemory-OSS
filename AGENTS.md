# AGENTS — Instructions for automated coding agents

This file gives focused, actionable guidance for AI agents working on OpenMemory. It complements `.github/copilot-instructions.md` by describing agent roles, the exact inputs we expect, common tasks, and the most important files and workflows to touch.

## Quick human summary

- Agent roles:
  - Info-gatherer: inspect code, tests, config, and produce a short summary of findings and the minimal next steps.
  - Code-synthesizer: implement a requested change (small feature/bugfix), create or modify files, and add tests where reasonable.
  - Reviewer / PR author: produce a concise PR description, list of modified files, and any follow-up manual checks.
  - Release/ops assistant: prepare changelogs, bump versions, and ensure build/test steps are included.

## Machine-readable agent instruction schema (for Gemini/other agents)

Agents should accept a single JSON or YAML instruction payload that follows this schema. The schema is intentionally small and deterministic so LLMs and automation agents can parse and act on it.

### JSON Schema (informative)

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

### Minimum required fields

- id: unique short id for the request (string)
- goal: one-sentence goal describing the change (string)

### Optional fields and semantics

- files: list of file paths or directories to consider. If omitted, agent may inspect the repo to decide.
- constraints: textual constraints (e.g., "no API breaking changes", "node=18").
  - tests: test names or commands to run after implementation (e.g., `bun test ../tests/backend/api.test.ts`).
- priority: scheduling hint for humans/automation.
- dry_run: if true, agent should produce a patch and tests but not commit or open a PR.

### Example request (JSON)

```json
{
  "id": "fix-hsg-decay-001",
  "goal": "Fix rounding bug in HSG decay computation so that salience never goes negative",
  "files": ["backend/src/memory/hsg.ts"],
  "constraints": ["no DB schema changes"],
  "tests": ["tests/backend/decay-reflection.test.js"],
  "priority": "high",
  "dry_run": false
}
```

### Expected agent outputs (machine-friendly)

- status: one of ["accepted","in_progress","completed","blocked","rejected"]
- patch: unified diff/patch text (if completed or dry_run)
- summary: short human-readable summary
- tests: map of test name -> {status, output}
- artifacts: list of created files or PR URL if opened

### Example response (JSON)

```json
{
  "status": "completed",
  "patch": "--- a/backend/src/memory/hsg.ts\n+++ b/backend/src/memory/hsg.ts\n@@ ...",
  "summary": "Fixed rounding bug by clamping salience to 0, added unit tests",
  "tests": {"decay-reflection.test.js": {"status": "passed", "output": "..."}},
  "artifacts": ["PR: https://github.com/.../pull/123"]
}
```

### Agent action contract (what to do when given the instruction)

1. Validate the input payload against the schema above. If required fields are missing, respond with status="rejected" and a validation error.
2. Run a fast repo scan of the listed `files` (or the repository root when `files` omitted) to collect context.
3. Produce a concise 'plan' (3–6 steps) describing the edits, tests, and verification commands.
4. Implement the smallest change needed to satisfy the goal. Prefer focused edits and unit tests.
5. Run the specified tests and local build (`npm run build` for TypeScript changes). Capture outputs.
6. Return a structured result (JSON) matching the expected agent outputs, and if `dry_run` is false, open a PR or apply the patch as configured by the repo policy.

### Exit criteria and safety checks

- Do not commit secrets (keys, tokens, private keys). If such data is found, abort and report.
- For database schema changes: update `backend/src/migrate.ts` and include migration tests that run against a temporary sqlite file.
- For public API changes: include a changelog entry and ask for human review.
- If the agent is blocked (missing permissions, unclear spec, risky change), return status="blocked" with a short human action required.

## What we expect from an agent when it acts (contract)

- Inputs: a single clear goal (one-sentence), list of target file paths (or top-level area like `backend/`), any constraints (e.g. Node version, must not change public API), and optional reproduction steps or failing test names.
- Outputs: concrete edits applied to the repo (via a PR or patch), a one-paragraph summary of the change, commands run (build/tests), and any failing checks with logs.
- Safety: never commit secrets or modify `data/openmemory.sqlite` directly. If a migration is required, update `backend/src/migrate.ts` and include a test/migration script.

## How to request work from an agent (best practice)

1. Provide a short title and goal (1 sentence).
2. Provide the minimal reproduction or failing test name if relevant.
3. Provide the exact files to edit or a directory to focus on.
4. State any constraints (version, env flags, no-breaking API).

## Examples (good request bodies)

- "Fix memory decay rounding bug in `backend/src/memory/hsg.ts`. Failing test: `decay-reflection.test.js`. Keep behavior unchanged for existing fixtures."
- "Add environment validation for `OM_DB_PATH` in `backend/src/core/cfg.ts` and ensure `docker-compose.yml` docs include the variable."

## Key repo workflows & commands (copyable)

- Backend dev: `cd backend && bun install && bun run dev`
- Run migrations: `cd backend && bun run migrate`
- Backend build: `cd backend && bun run build`
- Dashboard dev: `cd dashboard && npm install && npm run dev`
- Run tests: Python: `python -m pytest tests/`; JS: run test scripts under `backend/` or SDK folders.
- Docker local: `docker-compose up --build` (see `docker-compose.yml` for env toggles)

## Tests (exact commands)

- Backend integration tests are run with Bun and expect a running server. Run them like this:

```bash
# Start the backend in one terminal
cd backend
bun run dev   # or build + bun run start for production server

# In another terminal run the full backend test suite
bun test ../tests/backend/

# Or run a single test file
bun test ../tests/backend/api.test.ts
```

Note: `backend/package.json` includes a `test` script which uses Bun. Use `bun run test` or `bun test` to run the suite.

## CI and automation notes

- Current workflows (`.github/workflows/`) include Docker build and a contributors README job, but do not run the backend integration tests by default. We add a minimal `test-backend.yml` to run build/start/wait/run-tests in CI.
- If you change runtime flags or env defaults, update `docker-compose.yml` and the CI workflow accordingly.

## Files & hot spots to inspect first

- `backend/src/server/index.ts` — server entry and background tasks (decay, reflection)
- `backend/src/migrate.ts` — DB schema and migration pattern (idempotent SQL)
- `backend/src/memory/` — HSG, reflect, user_summary implementations
- `backend/src/ai/` — MCP / embeddings integration
- `dashboard/` — Next.js frontend (start here for UI work)
- `docker-compose.yml` — environment-driven feature flags and provider settings
- `tests/` — unit and integration tests, some fixtures include sqlite files (do not overwrite fixtures)

## Testing and validation expectations

- Run the relevant unit tests after changes. Prefer adding a small test when fixing a bug.
- For DB schema changes, add or update a migration entry in `backend/src/migrate.ts` and include a test against a temporary sqlite file.
- If you update TS code, run `npm run build` in `backend/` to verify type errors.

## PR and commit conventions

- Use conventional commit prefixes (e.g., `fix(...)`, `feat(...)`, `chore(...)`). Keep PR descriptions short and include the list of changed files.
- If a large refactor is required, ask for human review before merging.

## Security & safety rules

- Never add hardcoded secrets (API keys, private keys) to the repo. Use env variables and update `docker-compose.yml` docs instead.
- If you find certificate or secret blocks in the code, flag them in the PR and follow maintainers' direction.

## When you are finished

- Provide a short summary: what changed, why, how it was tested, and any manual follow-ups (e.g., run migrations, re-deploy Docker).
- If any tests fail, include the exact failing test names and stack traces.

## Contact points and follow-ups

- For design decisions or ambiguous API changes, open an issue and assign a human reviewer.
- When in doubt about HSG behavior, reference `backend/src/memory/hsg.ts` and ask for a domain-expert review.

Last updated: 2025-11-09

Maintainers / contact

- If you need help or approval for larger changes, ping the repo maintainers (add a real handle/email here). Example placeholder: `@maintainer-handle`.
