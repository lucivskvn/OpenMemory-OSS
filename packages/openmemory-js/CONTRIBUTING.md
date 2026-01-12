# Contributing to OpenMemory

We welcome contributions! Please follow these guidelines to ensure a smooth process.

## getting Started

1. **Fork and Clone**: Fork the repository and clone it locally.
2. **Install Dependencies**: Run `bun install`.
3. **Setup Environment**: Copy `.env.example` to `.env` and configure `OM_DB_PATH`.

## Development Workflow

- **Branching**: Use feature branches (e.g., `feature/new-vector-store`).
- **Testing**: Run `bun test` to execute the full suite.
- **Typecheck**: Run `bun run typecheck` to verify TypeScript types.
- **Linting**: Ensure code follows the project's style (prettier/eslint).

## Project Structure

- `src/core`: Core logic (Memory, Vector Store, DB).
- `src/server`: API Server (Routes, Middleware).
- `src/client.ts`: Client SDK.
- `tests`: Unit, Integration, E2E, and Performance tests.

## Key Principles

- **SCCI**: Sustainability, Consistency, Confidentiality, Integrity.
- **Strict Typing**: No `any` unless absolutely necessary.
- **Tests**: Add tests for new features (Unit + Integration).

## Pull Requests

- Keep PRs focused and small.
- Include a clear description of changes.
- Ensure all tests pass (`bun test`).
