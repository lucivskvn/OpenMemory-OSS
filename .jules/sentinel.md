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

## 2026-07-23 - [Inbound Webhook Signature Bypass in Python Backend]
**Vulnerability:** Inbound webhooks (GitHub, Notion) in the Python backend accepted payloads and executed raw ingestion logic directly without any signature validation, exposing the application to forgery, arbitrary memory pollution, and untrusted injections.
**Learning:** Multi-language monorepos often introduce functional/security parity drift where endpoint validations are strictly written in one framework/runtime (e.g. Express/Node GCM checks) but completely neglected in another (e.g. FastAPI/Uvicorn), creating an uneven security perimeter.
**Prevention:** Always enforce strict, fail-closed cryptographic signature validation (HMAC-SHA256) keyed by a secure env secret on both runtime endpoints, utilizing secure constant-time comparisons (`hmac.compare_digest`) and raw body payload verification.
