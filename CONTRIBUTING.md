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


## Testing

Backend tests (Bun):

```bash
cd backend
bun test                # run tests
bun test --watch        # watch mode
```

## Documentation and releases

- Update `CHANGELOG.md` (Unreleased) for any user-visible changes.
- Small doc edits should go as focused PRs to reduce merge conflicts.

## Security

- Never commit secrets. Use environment variables and update `docker-compose.yml` when necessary.

## Need help?

- Open an issue or join the project Discord.

Thank you for contributing! 🎉
