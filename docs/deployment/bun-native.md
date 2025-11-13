# Bun-native Deployment Notes

This short addendum describes Bun-specific considerations referenced by the changelog.

- Recommended Bun version: `v1.3.2` or newer.
- Use `bun install --frozen-lockfile --no-save` in CI to ensure deterministic installs.
- Prefer `Bun.file()` for large file reads/writes in ingestion/extraction paths. Use `Bun.file(path).arrayBuffer()` and convert to `Buffer` only when a third-party library requires Node `Buffer`.
- When building production bundles, use `bun build` and verify `dist/server/index.js` exists.
- For Podman / rootless builds, validate `podman build --userns=keep-id` as part of CI smoke checks.

Operational tips

- Enable `OM_EXTRACT_DNS_CHECK=true` to enforce conservative DNS-based SSRF protections in URL extraction paths.
- To opt into permissive `application/octet-stream` handling (legacy clients), set `OM_ACCEPT_OCTET_LEGACY=true` but be aware of classification risks.

Examples

```bash
# CI (deterministic installs)
cd backend
bun install --frozen-lockfile --no-save
bun run build
```
