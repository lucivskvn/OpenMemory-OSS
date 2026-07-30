# Sentinel's Journal - Critical Security Learnings

## 2025-03-01 - [TimingSafeEqual Input Length Leak and Crash Mitigation]
**Vulnerability:** Comparing variable-length client-provided secrets directly via `crypto.timingSafeEqual` is vulnerable to both key-length leakage (due to early exits on length mismatch) and potential application crashes/Denial of Service (DoS) under runtime environments like Node.js if comparing mismatched buffer byte sizes (which throws a fatal `TypeError` error).
**Learning:** Checking string lengths before comparison (`provided.length !== expected.length`) immediately leaks the exact length of the API key, defeating the purpose of constant-time comparisons. Additionally, directly wrapping raw strings into `Buffer.from()` and passing to `crypto.timingSafeEqual` triggers a runtime exception if the sizes differ, introducing DoS vectors.
**Prevention:** Always SHA-256 hash both the provided and expected keys into fixed-size buffers (32 bytes) prior to calling `crypto.timingSafeEqual`, and avoid any pre-comparison length checks on the strings.

## 2025-05-18 - [Cross-Tenant Data Leakage in Advanced Memory Dynamics Routes]
**Vulnerability:** The `/dynamics/...` endpoints (specifically `/dynamics/retrieval/energy-based`, `/dynamics/reinforcement/trace`, `/dynamics/activation/spreading`, `/dynamics/waypoints/graph`, and `/dynamics/waypoints/calculate-weight`) retrieved memories and waypoints without checking `user_id` ownership or enforcing tenant-isolation, exposing data cross tenants to any authenticated user.
**Learning:** In a multi-tenant API where auth middleware populates `req.tenant`, all background and helper retrieval functions that access core DB tables (like `memories` or `waypoints`) must explicitly accept and propagate the tenant identifier to prevent data exposure.
**Prevention:** Always verify ownership of resources (e.g., checking `user_id === tenant`) and ensure helper/retrieval utility functions are designed to receive and filter on the tenant identity.

## 2025-07-15 - Multi-Tenant Authorization Bypass in LangGraph Routes

**Vulnerability:**
The LangGraph integrations (`/lgm/*` HTTP endpoints and their associated service functions in `packages/openmemory-js/src/ai/graph.ts`) were not performing any authentication/authorization checks to partition user scopes. Regular authenticated API keys could query and mutate LangGraph node memories belonging to other tenants entirely (or store data under arbitrary/forged `user_id` values), resulting in a full isolation bypass.

**Learning:**
This vulnerability existed because LangGraph routes did not apply `require_tenant` and `reject_tenant_mismatch` validation middleware, and the underlying database/vector retrieval queries inside `graph.ts` did not filter by a target `user_id`. This bypassed the standard tenant-partitioning pattern used elsewhere in the codebase.

**Prevention:**
Always enforce a standard "defense-in-depth" rule where *all* user-interactive endpoints call middleware that maps the request to an authenticated tenant scope, and pass that `user_id` down to every single database query, search, and list operation. Validate and reject any explicit payload-supplied `user_id` that disagrees with the authenticated key.

## 2026-07-19 - [Server-Side Request Forgery (SSRF) and DNS Rebinding Protection]
**Vulnerability:** Retrieving user-provided URLs using unvalidated, raw global `fetch` is vulnerable to Server-Side Request Forgery (SSRF) and DNS Rebinding (TOCTOU) attacks, potentially exposing internal-only network endpoints and loopback services. Additionally, redirection without case-insensitive credential stripping can result in sensitive token/cookie leakage to untrusted third-party hosts.
**Learning:** Preventing SSRF requires resolving the domain name exactly once, verifying that the IP family (v4 or v6) does not fall into standard private/restricted ranges (including loopback, carrier-grade NAT `100.64.0.0/10`, and link-local subnets), and pinning the connection to the validated IP using native http/https requester clients with proper SNI headers.
**Prevention:** Always use `fetchWithSsrfProtection` when fetching untrusted, user-provided URLs, perform case-insensitive header checks before redirecting cross-origin, and enforce payload and timeout limits.

## 2026-07-20 - [Multi-Tenant Isolation Bypass and Memory Hijacking in Cluster Sync Route]
**Vulnerability:** The `/api/cluster/sync` route accepted arbitrary memory records to sync and deduplicate across clusters. However, it did not authenticate or scope incoming requests to a specific tenant identity. If an API key was validated, the client could provide any `user_id` in the payload (which would write the memory into that tenant's space), or provide an existing memory `id` belonging to a different tenant and successfully overwrite/hijack its contents, bypassing all multi-tenant boundaries.
**Learning:** Endpoints that handle database-level syncing or batch operations are often overlooked for individual tenant boundaries. Even if requests are authenticated, we must validate payload-supplied identifiers (`data.user_id`) against the verified session tenant (`req.tenant`), coerce unspecified identifiers to the tenant, and verify ownership of existing primary keys (`data.id`) prior to running an upsert/overwrite.
**Prevention:** Always retrieve the authenticated tenant identity with `require_tenant`, use `reject_tenant_mismatch` to reject spoofed client payloads, and fetch/validate the tenant ownership of any pre-existing record with the target ID before allowing an update.

## 2026-07-21 - [Unauthenticated Inbound Ingestion Webhooks on Python FastAPI Server]
**Vulnerability:** While the TypeScript SDK implemented strict HMAC-SHA256 signature verification for inbound webhook endpoints (`/sources/webhook/github` and `/sources/webhook/notion`), the Python FastAPI server accepted and processed these webhook payloads completely unauthenticated and unsigned. This allowed any remote attacker to bypass tenant isolation boundaries and ingest arbitrary data into the system.
**Learning:** In a polyglot monorepo with multiple runtime servers (TypeScript and Python), security middleware and route-level validation (such as cryptographic signature verification) can easily get overlooked or omitted in one of the runtimes during feature ports, causing massive security disparities.
**Prevention:** Always verify that security controls, auth middleware, and validation checks have 100% parity across all runtime environments, and write automated tests checking for unauthorized rejection of forged/unsigned requests.

## 2026-07-22 - [Cross-Origin Credential Leakage on SSRF Redirects in Python SDK]
**Vulnerability:** In custom SSRF-protected HTTP clients, enabling automatic redirection can lead to severe credential leakage if case-insensitive custom request headers (such as `Authorization`, `Cookie`, `Cookie2`, and `X-API-Key`) or raw keyword argument credentials (such as `auth` and `cookies`) are forwarded to third-party, cross-origin redirect destinations.
**Learning:** While standard HTTP libraries automatically strip certain authorization headers on cross-origin redirects, they fail to strip custom headers or user-supplied connection/session credentials. Securing client fetch requests requires intercepting redirects manually, validating host schemes, and explicitly deleting/popping sensitive headers and options before following the redirect.
**Prevention:** Disable native client-level redirect following. Handle redirects manually in a loop, compare schemes and netlocs to identify cross-origin boundaries, and strip case-insensitive sensitive keys and parameter structures accordingly on cross-origin redirects.

## 2026-07-23 - [Missing API Key Authentication and Tenant Isolation in Python FastAPI Server]
**Vulnerability:** The Python FastAPI server's endpoints (`/memory/add`, `/memory/search`, `/memory/history`, and `/sources/{source}/ingest`) were completely unauthenticated, allowing any remote caller to read/write arbitrary tenant memories by passing/spoofing any `user_id` payload values, completely bypassing all tenant isolation boundaries.
**Learning:** In polyglot/multi-package applications, security validation layers such as API key authentication and multi-tenant mapping can easily remain unported during feature parity expansions, leaving one language runtime wide open. Timing-safe comparisons must also be enforced in Python similarly to TypeScript using hashed digests (`hmac.compare_digest` with SHA-256 pre-hashing).
**Prevention:** Implement secure constant-time API key verification middleware on all non-public endpoints in Python, map validated credentials to request-scoped tenant IDs, and strictly validate or coerce user-provided payload scopes against the verified tenant ID.
