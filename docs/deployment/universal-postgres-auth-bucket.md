# Universal Postgres, Auth, and Bucket Configuration

This guide describes how to configure Postgres (self-hosted or Supabase), authentication (JWT/OIDC vs Supabase GoTrue), and S3-compatible buckets (MinIO, Supabase Storage, AWS S3) for OpenMemory deployments.

## Postgres (libpq URI usage)

Use a libpq URI for universal configuration. Only simple host:port/database URIs with optional `sslmode` and `host` query parameters are supported; socket-style URIs (e.g., `host=/path/to/socket`) or multi-host libpq URIs (containing comma-separated hostnames in the hostname portion) are not. URIs using `host=/path` or multiple hosts will be rejected and result in fallback to discrete `OM_PG_*` env vars. Additional query string parameters beyond `sslmode` and `host` are ignored and logged as warnings.

Empty hostnames or unsupported socket-style URIs will be rejected, and in those cases OpenMemory will log a `[DB]` warning and continue using `OM_PG_HOST`, `OM_PG_PORT`, `OM_PG_DB`, `OM_PG_USER`, and `OM_PG_PASSWORD` instead.

- Only single-host TCP URIs are supported; multi-host/high-availability URIs must be configured via discrete `OM_PG_*` env vars

```bash
# Example: self-hosted Postgres
OM_PG_CONNECTION_STRING=postgresql://user:password@127.0.0.1:5432/openmemory?sslmode=require

# Example: Supabase connection (requires SSL)
OM_PG_CONNECTION_STRING=postgresql://postgres:ABCD1234@db.xxxxxx.supabase.co:5432/postgres?sslmode=require
```

sslmode options:

- `disable` – no TLS
- `require` – TLS but skips certificate verification (use in some managed DB cases)
- `verify-full` – TLS with CA verification, recommended for production

**SSL/TLS precedence:** When `OM_PG_CONNECTION_STRING` is set and valid, its `sslmode` parameter fully determines SSL/TLS behavior and `OM_PG_SSL` is ignored. When the connection string is not set or rejected, `OM_PG_SSL` controls SSL configuration.

Connection pooling:

- Use a Postgres pooler (pgbouncer, supavisor) for high-concurrency workloads.
- When using Supabase, prefer transaction mode for prepared statements compatibility.

### RLS and OIDC Tokens

To enable PostgREST or RLS, configure an OIDC provider and set the JWT secret in the server:

```bash
OM_AUTH_PROVIDER=jwt
OM_JWT_SECRET=some-symmetric-secret-or-jwks-url
OM_JWT_ISSUER=https://auth.example.com/
OM_JWT_AUDIENCE=urn:openmemory
```

**Note:** See JWT/OIDC vs HTTP API key behavior in SECURITY.md. Ensure `OM_API_KEY` remains configured when using JWT/OIDC features.

RLS example (Postgres):

```sql
CREATE POLICY user_is_owner ON memories USING (user_id = current_setting('jwt.claims.sub')::text);
```

This assumes the IdP issues `sub` claim containing the `user_id`. Use `jwt.claims` for PostgREST or `auth.uid()` for Supabase specific functions.

## Auth: Self-hosted vs Supabase GoTrue

- `OM_AUTH_PROVIDER=jwt`: Use (must be explicitly set) when you manage your own OIDC provider. Set OM_JWT_{SECRET,ISSUER,AUDIENCE}. When `OM_AUTH_PROVIDER=jwt` is set without `OM_JWT_SECRET`, development mode logs a warning and falls back to API-key-only auth (in development mode) or exits with code 1 (in production-like modes), unless `OM_TEST_MODE=1` is set, which suppresses the hard process exit during automated tests. Unset OM_AUTH_PROVIDER defaults to API-key-only authentication.
- `OM_AUTH_PROVIDER=supabase`: Use Supabase GoTrue for auth. Set `OM_PG_CONNECTION_STRING` to Supabase DB and hook into Supabase Auth config. Ensure RLS is configured for row-level user isolation.

Best practices:

- Rotate JWT signing keys regularly
- Store keys in a secure secrets store (Bun.secrets, HashiCorp Vault, cloud KMS)
- Validate the issuer and audience when verifying tokens

## Bucket storage (S3-compatible)

MinIO example (self-hosted):

```bash
OM_BUCKET_PROVIDER=minio
OM_BUCKET_ENDPOINT=http://localhost:9000
OM_BUCKET_ACCESS_KEY=minioadmin
OM_BUCKET_SECRET_KEY=minioadmin
OM_BUCKET_REGION=us-east-1
OM_BUCKET_FORCE_PATH_STYLE=true
OM_BUCKET_NAME=openmemory-fixtures
```

Supabase Storage example:

```bash
OM_BUCKET_PROVIDER=supabase
OM_BUCKET_ENDPOINT=https://xyz.supabase.co
OM_BUCKET_ACCESS_KEY=public-xyz
OM_BUCKET_SECRET_KEY=secret-xyz
OM_BUCKET_NAME=uploads
```

S3 SDK example (AWS SDK v3):

```js
import { S3Client } from "@aws-sdk/client-s3";
const client = new S3Client({ region: process.env.OM_BUCKET_REGION, endpoint: process.env.OM_BUCKET_ENDPOINT, forcePathStyle: process.env.OM_BUCKET_FORCE_PATH_STYLE === 'true', credentials: { accessKeyId: process.env.OM_BUCKET_ACCESS_KEY, secretAccessKey: process.env.OM_BUCKET_SECRET_KEY } });
```

Security and lifecycle:

- Use bucket policies to restrict public access
- Enable encryption at rest and in transit
- Rotate bucket credentials regularly and use temporary tokens where possible

## Validation Notes

**SSL/TLS precedence:** When a valid `OM_PG_CONNECTION_STRING` is provided, its `sslmode` parameter fully controls SSL/TLS behavior and `OM_PG_SSL` is ignored; otherwise `OM_PG_SSL` is used with discrete host/user/db vars.

**Troubleshooting:** When an invalid connection string is provided, the backend logs a `[DB] Failed to parse OM_PG_CONNECTION_STRING; falling back...` warning and continues using the previous env-style configuration.

OpenMemory performs runtime validation of auth and bucket configurations during startup to prevent operational issues. Check the logs for `[CFG]` prefixed messages.

**Authentication Validation:**

- jwt provider without `OM_JWT_SECRET` degrades to API-key-only auth (development mode) or causes fatal exit (production modes)
- Auth provider and available features are logged at startup

**Bucket Validation:**

- When bucket provider is configured, S3 requires `OM_BUCKET_ACCESS_KEY` and `OM_BUCKET_SECRET_KEY` (endpoint/region optional for AWS defaults)
- All other bucket providers require the full set of endpoint, access key, and secret key when configured
- When bucket config is completely absent (no provider set), startup does not emit a warning, and bucket functionality is simply disabled

For detailed startup behavior and log interpretation, see the Runtime Configuration Validation section in SECURITY.md.

## Example `.env` variables

```
OM_PG_CONNECTION_STRING=postgresql://user:password@host:5432/openmemory?sslmode=require
OM_AUTH_PROVIDER=jwt
OM_JWT_SECRET=$ARGON2ID_JWT_SECRET
OM_JWT_ISSUER=https://auth.example.com
OM_JWT_AUDIENCE=openmemory
OM_BUCKET_PROVIDER=minio
OM_BUCKET_ENDPOINT=http://minio:9000
OM_BUCKET_ACCESS_KEY=minioadmin
OM_BUCKET_SECRET_KEY=minioadmin
OM_BUCKET_FORCE_PATH_STYLE=true
OM_BUCKET_NAME=openmemory-files
```

---

See `backend/src/core/cfg.ts` for additional environment schema and validation. For Postgres connection string details, see `backend/src/core/db.ts`.
