# Contributing to OpenMemory

<!-- markdownlint-disable MD040 -->

We welcome contributions of all kinds: bug reports, patches, docs, and feature proposals.

## Quick workflow

1. Fork the repo and create a branch from `main`.
2. Add tests when you add behavior.
3. Keep changes focused and open a PR explaining the rationale.
4. Ensure the test suite passes and linting is clean.

## Development setup

### Prerequisites

- Bun v1.3.2 or higher (recommended)
- Node (for local tooling only, if needed)
- Python 3.8+ (for Python SDK work)
- Docker (optional for containerized development)

### Linux Mint 22 / Ubuntu 24.04 notes

If you use Linux Mint 22 (Ubuntu 24.04 base) for development, add the following prerequisites:

- `podman` for local containerization and `podman-compose` for docker-compose replacement
- `build-essential`, `libssl-dev` for native module builds used by Bun and some SDKs
- Ensure `subuid`/`subgid` are correctly configured when using rootless Podman

Quick install example (Mint 22 / Ubuntu 24.04):

```bash
sudo apt update
sudo apt install -y curl unzip ca-certificates build-essential libssl-dev git podman podman-compose podman-docker pkg-config
# Optional: jq and vim for convenience
# sudo apt install -y jq vim
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.2"
# After installation, export Bun to PATH for the current session:
export PATH="$HOME/.bun/bin:$PATH"
# For persistence across sessions, add the line above to ~/.bashrc or ~/.zshrc.
```

See `docs/deployment/linux-mint-22-setup.md` for the source of truth for Mint 22 setup.

### Backend (TypeScript + Bun)

```bash
cd backend
bun install --frozen-lockfile
bun run dev
```

Run tests:

```bash
cd backend
bun test
```

### Dashboard (Next.js + Bun)

The dashboard is built with Next.js 16 and Vercel AI SDK v5, optimized for Bun runtime:

```bash
cd dashboard
bun install --frozen-lockfile
bun run dev  # Starts on http://localhost:3000
```

**Environment Setup:**

Create `dashboard/.env.local`:

```bash
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_API_KEY=your-api-key-here
```

**Build for Production:**

```bash
bun run build
bun run start  # Production server
```

**Verification:**

```bash
bun run verify:bun  # Check Bun + Next.js compatibility
```

**Troubleshooting:**

- If you encounter module resolution issues, try `rm -rf node_modules .next && bun install`
- For Next.js cache issues, run `bunx next clean` before rebuilding
- If AI SDK streaming doesn't work, verify the backend is running and `NEXT_PUBLIC_API_URL` is correct

**Node.js Fallback:**

If you need to use Node.js instead of Bun:

```bash
npm install
npm run dev:node
```

### Extract DNS checks (SSRF protection)

The backend supports an optional DNS-based safety check for URL extraction and ingestion flows. Set the following environment variable in production to enable conservative DNS checks that block hosts resolving to private or loopback IP ranges:

```bash
OM_EXTRACT_DNS_CHECK=true
```

We recommend enabling `OM_EXTRACT_DNS_CHECK=true` in production deployments (and CI runs that exercise URL extraction) to reduce SSRF risk. If your runtime does not expose a DNS resolver, the code will fall back to literal host checks unless this feature is explicitly enabled — in that case DNS resolution failures are treated as blocked to preserve safety.

### MIME types and octet-stream handling

When contributing to ingestion or extraction code, prefer enforcing accurate MIME types from clients rather than relying on `application/octet-stream`. The backend performs lightweight magic-bytes detection for `application/octet-stream` (PDF and ZIP/DOCX) but this can misclassify unknown binaries. For backward-compatibility a runtime opt-in exists: set `OM_ACCEPT_OCTET_LEGACY=true` to allow permissive octet-stream decoding as UTF-8 text. Document any changes to this behavior in PR descriptions and tests.

Example (opt-in legacy behavior):

```bash
# Permissive octet-stream acceptance (may misclassify binary files as text)
export OM_ACCEPT_OCTET_LEGACY=true
bun run dev
```

Trade-offs:

- Pros: preserves compatibility with clients that send generic `application/octet-stream` without correct MIME types; avoids immediate rejections.
- Cons: may incorrectly treat binary files as text (risk of data leakage or parser errors). Prefer fixing clients to send accurate MIME types when possible.

## Code style and commits

- Use TypeScript for new backend code.
- Follow ESLint and Prettier rules.
- Use conventional commits: `type(scope): summary` (e.g., `fix(db): avoid NULL insert`).

## Bun-native development (recommended)

When editing the backend we encourage Bun-native patterns to gain runtime advantages:

- Prefer `Bun.file()` for large file reads/writes (ingest, extraction).
- Use `Bun.password.hash` / `Bun.password.verify` for API key and credential hashing; prefer centralized helpers in `backend/src/utils/crypto.ts`.
- Convert `ArrayBuffer`/`Uint8Array` to Node `Buffer` only at shim boundaries when third-party libs require it: `Buffer.from(arrayBuffer)`.
- Add `@types/bun` to devDependencies and include Bun typings in `tsconfig.json` (e.g., `"types": ["@types/node","@types/bun"]`) to avoid editor/CI type warnings.
- In CI use `bun install --frozen-lockfile` and pin Bun setup actions/images.

### Bun Native Best Practices

The project follows a Bun-first development model. Please follow these patterns to keep code consistent, performant, and secure:

- I/O: prefer `Bun.file()` for large file reads and writes (ingest/extract paths). Use `Bun.file(path).arrayBuffer()` and convert to `Buffer` only when a third-party library requires Node buffers.
- SQL: prefer parameterized queries and the Bun-native database clients when available. Avoid exposing raw query strings; use prepared statements and transactions where appropriate.
- Passwords & Secrets: use `Bun.password.hash` and `Bun.password.verify` or the centralized helper at `backend/src/utils/crypto.ts` for hashing and verification.
- Files: enforce size guards on uploads (example: 200 MB max for ingestion) and validate content types before processing.
- Tests: use `bun:test` and prefer in-memory or temp-file based tests. Tests that require Bun-only APIs should be gated or run under Bun CI.
- Build: use `bun run build` and ensure any generated artifacts are listed in `.gitignore`.

### Bun Native Best Practices - Dashboard

When contributing to the dashboard, follow these Bun-specific patterns:

- **Scripts**: Always use `bunx --bun next <command>` for Next.js commands to ensure Bun runtime is used
- **Dependencies**: Use `bun add <package>` to add new dependencies, not `npm install`
- **Lockfile**: Commit `bun.lockb` changes when updating dependencies
- **Testing**: Use `bun test` for any dashboard tests (future)
- **Build**: Use `bun run build` for production builds, which is ~2x faster than npm
- **Environment**: Use `.env.local` for local development secrets (never commit this file)

**AI SDK Integration:**

The dashboard uses Vercel AI SDK v5.0.93 for chat functionality. When working with AI features:

- Import from `@ai-sdk/react` for React hooks (`useChat`, `useCompletion`)
- Use Server Actions or API routes for streaming responses
- Follow the patterns in `dashboard/app/chat/page.tsx` for memory-augmented chat
- Test streaming with the backend running on port 8080

Expanded AI SDK guidance:

- `useChat` - Preferred client-side hook for streaming chat state and handling message history. Consider this for PHASE 6.5 integration.
- `useCompletion` - For serverless streaming completions and basic text generation when you don't need full chat semantics.
- `streamText` - Use server-side when producing streaming LLM text; works with RSC and Bun web streams.
- `createStreamableValue` - Useful in RSC server-side components for stepwise streaming of values.
- `streamUI` - For generative UI helpers (RSC)

Server functions & patterns:

- Use `streamText` server utilities for LLM streaming flows and integrate with OpenMemory memory augmentation.
- Use custom SSE (`ReadableStream`) as a widening fallback for current implementation; `dashboard/app/api/chat/route.ts` demonstrates a memory-first SSE flow.

Verification and best practices:

- Run `cd dashboard && bun run verify:ai-sdk` to execute the automated verification script (checks Bun version, OS, AI SDK import, and Web APIs).
- Use `bun pm ls ai` to confirm installed version is `5.0.93`.
- Use `.env.local` for API keys and never commit secrets.
- To ensure Bun runtime for next commands, use `bunx --bun next dev`.

Troubleshooting:

- If `Cannot find module '@ai-sdk/react'` occurs, run `rm -rf node_modules .next bun.lockb && bun install --frozen-lockfile`.
- If streaming fails, ensure backend `/api/chat` is reachable on `http://localhost:8080/` and check CORS.
- If `EventSource` is missing from runtime, consider using a polyfill or a `fetch` based SSE client for Bun.

**Performance Tips:**

- Bun's faster module resolution reduces Next.js dev server startup time by ~40%
- Use `bunx next clean` to clear Next.js cache if you encounter stale builds
- For production builds, `bunx --bun next build` is ~2x faster than Node.js

### CLI helpers and pinned tools

- Prefer `bunx` for running pinned CLIs instead of `npx`. With `bunx -p <pkg>@<ver> <cmd>` you get a reproducible CLI version across machines and CI without updating repo-level node packages. Examples:

```bash
# Run a pinned serve binary (instead of `npx serve`)
bunx -p serve@14.0.1 serve -s ./build
# Run pinned prettier for local fixes (matching CI)
bunx -p prettier@3.3.3 prettier --write .
```

- Node fallback: the repository prefers Bun across tooling, but maintains Node runtime compatibility for some tasks. If Bun is not available in your local environment, you can use equivalent `npm`, `npx`, or `node` commands as a fallback. When making CI or tooling changes in a PR, include a short note on Node compatibility and required runtime if you change defaults.

### Router and SIMD Testing

When working with embedding providers and vector operations, run these specialized test suites for CPU deployment validation:

- **Router tests**: `bun test:router` - tests sector-based routing, fallback handling, Ollama integration, and cache TTL behavior. Verifies router_cpu mode with `OM_EMBED_KIND=router_cpu OM_ROUTER_SIMD_ENABLED=true`.
- **SIMD tests**: `bun test:simd` - benchmarks vector operations (dot product, normalization, fusion) comparing SIMD vs JavaScript implementations. Expects 20-30% performance improvement with SIMD enabled.
- **Config endpoint tests**: `bun test:config` - validates `/embed/config` shape and mode switching with proper fallback handling.

For CPU deployments, test with `OM_EMBED_KIND=router_cpu OM_SIMD_ENABLED=true` and mock Ollama at `http://localhost:11434`. Use fake timers (`vi.useFakeTimers()`) for reliable cache and performance testing. Example benchmark command: `bun run benchmark:embed` to validate P95 latency <150ms.

### Security Guidelines for GitHub Workflows

- SHA pin all `uses:` entries to a specific commit SHA and add a human-readable comment with the tag version (e.g., `actions/checkout@<sha> # v4.1.1`).
- Use OIDC for cloud provider authentication: set `permissions: id-token: write` only at the job level that needs to assume a cloud role.
- Generate SLSA provenance attestations for production image builds and publish them alongside images. Use `actions/attest-build-provenance` and ensure `attestations: write` is granted only to jobs that create attestations.
- Run vulnerability scanning (Trivy) for images and filesystem SARIF uploads to the Security tab. Keep `security-events: write` scoped to the scanning job.

### Bun install / CI install mode

- CI should perform isolated installs to avoid accidental lockfile mutations or transitive update behavior. Use `bun install --frozen-lockfile --no-save` in CI to preserve lockfile fidelity and avoid writing package manifests from CI runs.
- To document this preference, add a `backend/bunfig.toml` file with `isolated = true` in the `[install]` section (this repo includes such a file). Local developers can omit `--no-save` when intentionally updating dependencies, but always run `bun pm outdated` and `bun update` locally and open a PR for lockfile changes.

**Dependency pinning rule:** New runtime dependencies MUST be pinned to a specific semver (for example, `^2.17.2`). Do not add wildcard `*` entries for production/runtime dependencies; wildcards are only acceptable for ephemeral dev tooling where reproducibility is not required. Open a Dependabot or manual PR to upgrade pinned dependencies and update the lockfile.

Example commit messages:

- `perf(bun): use Bun.file() for large payload read in ingest`
- `security(workflow): SHA-pin actions and add SLSA attestation to publish job`

### Podman development

- For rootless development and systemd integration, provide Quadlet files under `podman/` and validate using `podman build --userns=keep-id` and `podman run` with non-root user namespaces.
- When using Podman compose, prefer `podman compose` (libpod) over `docker-compose` for rootless environments.
- Rootless Podman note: ensure user is part of `render` and `video` groups for GPU passthrough, and test GPU with `nvidia-smi` or `vulkaninfo`.

## Testing

Backend tests (Bun):

```bash
cd backend
bun test                # run tests
bun test --watch        # watch mode
```

### Testing on Linux Mint 22

OpenMemory is optimized for Linux Mint 22 (Ubuntu 24.04 base) with Bun v1.3.2. Follow the steps below for comprehensive testing.

Prerequisites: Bun 1.3.2, build-essential, libssl-dev, Podman (optional).

Test suites (short commands):

- Unit Tests: `cd backend && bun test` (fast)
- Integration: `bun run test:ci` (DB + API endpoints)
- E2E: `bun run test:e2e` (full stack)
- Benchmarks: `bun run test:benchmarks` (competitor comparisons)
- Performance: `bun run benchmark:embed` (SIMD/perf tests)

Run everything locally on Mint 22:

```bash
cd backend
bun run test:all
```

See `docs/testing/linux-mint-22-testing.md` for a complete guide on setup and troubleshooting.

## Documentation and releases

- Update `CHANGELOG.md` (Unreleased) for any user-visible changes.
- Small doc edits should go as focused PRs to reduce merge conflicts.
- Follow JSDoc/TSDoc guidelines in `docs/development/jsdoc-guidelines.md` when adding or changing public APIs and scripts.

## Security

- Never commit secrets. Use environment variables and update `docker-compose.yml` when necessary.

## Need help?

- Open an issue or join the project Discord.

Thank you for contributing! 🎉
