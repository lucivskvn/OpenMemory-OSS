# Backend — OpenMemory

This directory contains the backend server for OpenMemory. It is a Bun + TypeScript service that provides the HTTP API and background workers used by the project.

## Important operational notes

- The server expects the `OM_API_KEY` environment variable to be a hashed value (argon2-compatible). Plaintext API keys are rejected by default to reduce the risk of accidental secret leakage.

- A helper script is included to generate a hashed API key:

```bash
cd backend
# Provide the plaintext key on the command line (avoid committing it):
bun run scripts/hash-api-key.ts "my-very-secret-key"

# Or pass the key via an environment variable:
OM_PLAIN_API_KEY="my-very-secret-key" bun run scripts/hash-api-key.ts
```

The script prints a hashed string suitable for storing as the `OM_API_KEY` repository secret or environment variable.

### Admin API key support

A separate admin key may be used to secure privileged endpoints such as telemetry and audit APIs. The admin key should be stored hashed in the backend using the `OM_ADMIN_API_KEY` environment variable (Argon2 hash). To allow dashboard or other server-side components to call these admin-only endpoints, set `OM_ADMIN_API_KEY_PLAIN` in the dashboard/runtime environment with the plain-text admin key. The backend will verify the provided plain key against the hashed `OM_ADMIN_API_KEY` using Argon2. This allows server-to-server calls without exposing admin secrets to the browser.

Example:

1. Create a hash with the helper: `bun run scripts/hash-api-key.ts 'my-admin-secret'`
2. Set `OM_ADMIN_API_KEY` (backend) to the returned hash, and `OM_ADMIN_API_KEY_PLAIN` (dashboard server) to `'my-admin-secret'`.

### CORS credentials

If your consumers require cookies or credentialed CORS requests, you can enable the server to return Access-Control-Allow-Credentials: true by setting the environment variable:

```bash
OM_CORS_CREDENTIALS=true
```

Note: enabling credentials requires careful consideration of Access-Control-Allow-Origin (avoid using `*` with credentials in production). Consider setting explicit origins in a reverse proxy when enabling credentials.

### Environment variables

- `OM_CORS_CREDENTIALS` (default: `false`) — when set to `true` the server will include `Access-Control-Allow-Credentials: true` on CORS-enabled responses. Use this only when you need credentialed cross-origin requests (cookies, Authorization headers) and ensure you do not use `*` for `Access-Control-Allow-Origin` in production.

For streaming endpoints (SSE, file downloads, or other handlers that return a locked/streaming body), the CORS middleware may interfere with Bun's streaming optimizations if it attempts to clone or rewrap a locked body stream. To opt-out for a specific route handler, set `ctx.skipCors = true` in your handler before returning the streaming `Response`.

Example (SSE-like handler):

```ts
// inside your route handler (req, ctx)
ctx.skipCors = true; // ensure the CORS middleware leaves the streaming response untouched
const stream = new ReadableStream({ /* ... */ });
return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
```

## CI / deployment

- Store the hashed `OM_API_KEY` in your deployment environment or GitHub repository secrets.
- The repository includes a PR-time workflow that validates `OM_API_KEY` looks hashed; the workflow is intentionally skipped when the secret is not present (so forks and external PRs aren't blocked).

## Migration steps

1. Generate a hashed key with the helper script above.
2. Update your runtime environment or repo secret `OM_API_KEY` with the hashed value.
3. Restart the server.

If a temporary grace period is required to accept plaintext keys during migration, open an issue or ask maintainers — the default posture rejects plaintext keys for security.

## Legacy handler migration checklist

To smooth the migration from legacy Express-style handlers (signature: (req, res)) to the modern (req, ctx) handlers, the server defaults to legacy-compatible behavior for one release cycle. Use the following checklist to migrate handlers and opt into the stricter mode:

- Audit your route handlers and middleware. If a handler calls res.json/res.send or expects an Express-style `res` object, mark it explicitly as legacy by setting `handler.__legacy = true`.
- Run your test suite and enable `OM_LEGACY_HANDLER_MODE=false` in a staging environment to find handlers that need updating.
- Update handlers to return a Response or a serializable value from the modern `(req, ctx)` signature. Remove reliance on `res` where possible.
- Once all handlers are migrated, set `OM_LEGACY_HANDLER_MODE=false` in production to opt into the modern behavior. This opt-out flag ensures a safe migration window.

### Legacy-default behavior (migration window)

During the migration window the server defaults to legacy-compatible mode to avoid breaking existing handlers that return undefined or expect `res` shims. To switch to strict modern behavior (where handlers must return a Response or a serializable value), set the environment variable:

```bash
OM_LEGACY_HANDLER_MODE=false
```

When this is set, the server will refuse legacy handler semantics and handlers must be migrated to the modern `(req, ctx)` contract.

If you need help, open an issue describing any handlers that cannot be migrated and include a minimal example.

## Files of interest

- `src/` — server source
- `scripts/hash-api-key.ts` — helper to generate hashed API keys
- `src/types/bun-sqlite.d.ts` — TypeScript declaration for Bun's sqlite surface (expanded for clarity)

For development and test commands, see the repo root README.md for exact commands. Typical backend dev workflow:

```bash
cd backend
bun install
bun run dev
```

Thanks — keep secrets hashed!

## Backend — notes

This directory contains the OpenMemory backend service (TypeScript + Bun).

### Bun configuration and developer notes

- Bun project file: `backend/bunfig.toml` — canonical Bun settings for install, test, run, and build.
- Run tests and development commands from the `backend/` directory so Bun picks up `backend/bunfig.toml`.

### Quick commands

```bash
cd backend
bun install            # installs dependencies (frozen-lockfile enforced by bunfig)
bun run dev            # starts dev server with hot-reload (uses bunfig run.hot)
bun test               # runs backend tests (bunfig.test.preload is applied)
bun test --coverage    # run tests with coverage
bun run build          # build compiled artifacts to dist/
```

### Notes

- The `bunfig.toml` file configures test preload scripts, timeout, and coverage reporting.
- CI pipelines should `cd backend` before invoking Bun commands to ensure the correct bunfig is used.
- See `CONTRIBUTING.md` for more development setup and guidelines.
