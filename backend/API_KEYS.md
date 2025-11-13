API Key hashing and migration
=================================

This project requires the server API key (`OM_API_KEY`) to be stored as a hashed value (argon2-compatible). Plaintext API keys are rejected at runtime.

Why hashed keys?

- Prevents accidental leakage of plaintext keys in logs, environment dumps, and CI.
- Enables secure verification using constant-time, battle-tested password APIs.

How to generate a hashed API key

1. In the `backend/` directory you can use the bundled helper script:

```bash
cd backend
# Provide the plaintext key on the command line (avoid committing it):
bun run scripts/hash-api-key.ts "my-very-secret-key"

# Or pass the key via an environment variable:
OM_PLAIN_API_KEY="my-very-secret-key" bun run scripts/hash-api-key.ts
```

The script will print a hashed string suitable for setting as the `OM_API_KEY` repository secret or environment variable.

CI / deployment

- Store the hashed string in your deployment environment or GitHub repository secret as `OM_API_KEY`.
- The CI workflow includes a validation step (on pull requests) that fails the build if the `OM_API_KEY` secret appears to be plaintext.

Migration path

1. Generate a hashed key using the helper script above.
2. Update your runtime environment or repository secret `OM_API_KEY` with the hashed value.
3. Restart the server.
4. If you previously relied on plaintext keys, rotate them and inform integrators of the change.

If you need a temporary grace period to support plaintext keys, contact maintainers — by default the code rejects plaintext to improve security.
