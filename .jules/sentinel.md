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

## 2026-07-23 - [Authentication Bypass via Permissive Prefix Matching in Public Endpoint Checks]
**Vulnerability:** The API key authentication middleware allowed endpoints to bypass verification if their path started with one of the public endpoints (using `path.startsWith(e)`). This allowed sensitive paths like `/health-secrets` or `/dashboard/health-admin` to completely bypass API key checks.
**Learning:** Checking subpaths using broad prefix match `path.startsWith(e)` without trailing slash separation exposes the application to prefix-based bypasses.
**Prevention:** Always strictly validate public/bypass paths using exact matches (`path === e`) or subdirectory-delimited checks (`path.startsWith(e + "/")`).

## 2026-07-24 - [Cross-Tenant Statistics Leakage in MCP Server Configuration Resource]
**Vulnerability:** The `openmemory://config` MCP resource query retrieved and aggregated memory statistics across all tenants in the database, ignoring the authenticated tenant identity. Any authenticated tenant calling the MCP config resource could view database-wide aggregation stats, violating tenant isolation boundaries.
**Learning:** Secondary resources (such as configuration snapshots, system info, or diagnostic resources) inside protocol adapters like the Model Context Protocol (MCP) are often omitted during manual audit checks for tenant filtering, introducing subtle cross-tenant data leaks.
**Prevention:** Always ensure that *all* queries fetching or aggregating database rows inside any API layer, including MCP tool/resource definitions, filter dynamically by the authenticated `tenant` context whenever it is available.

## 2026-07-25 - [Multi-Tenant Isolation Gap and Error Leakage in Inbound Webhooks]
**Vulnerability:** Inbound third-party webhooks (GitHub, Notion) ingested document payloads without specifying any target `user_id`, causing all webhooks to write data to a single globally co-mingled `"anonymous"` tenant space. Additionally, unhandled exception handlers on webhook routes returned raw `e.message` to callers, risking leakage of sensitive API keys, system paths, or database structure details.
**Learning:** Webhook endpoints frequently bypass standard API key authentication since they are invoked by external third parties. However, failing to associate incoming webhook payloads with a validated query-provided tenant ID (`user_id`) completely defeats multi-tenant partitioning. Furthermore, raw exception message leakage is a critical information disclosure vector.
**Prevention:** Extract and validate an optional `user_id` query parameter on HMAC-verified webhook routes to isolate data, and always catch internal errors to return generic, sanitized responses (such as "Webhook processing failed") instead of raw traceback/message payloads.

## 2026-07-26 - [Cross-Tenant Data Loss via Unscoped Waypoints Deletion]
**Vulnerability:** Waypoints deletion query `DELETE FROM waypoints WHERE src_id=? OR dst_id=?` did not enforce any tenant/`user_id` boundaries. A tenant deleting their own memory was able to delete waypoints referencing identical memory IDs belonging to completely different tenants, causing cross-tenant data loss and isolation bypass.
**Learning:** In a multi-tenant application where resources are linked in a graph, cascade and reference deletions must be meticulously scoped to the authorized tenant to prevent accidental or malicious destruction of other tenants' links.
**Prevention:** Always accept and enforce `user_id`/tenant parameters on query statements that delete association links, waypoints, or relational records, ensuring they are strictly partitioned to the authorized tenant scope.

## 2026-07-27 - [Unbounded Pagination and Search Limit DoS in Python SDK]
**Vulnerability:** The `/history` and `/search` API endpoints accepted user-controlled `limit` and `offset` values without checking their bounds or sign. In SQLite, a negative limit like `-1` is interpreted as "no limit", allowing clients to trigger full-table query execution and bypass standard pagination boundaries. Extremely large limits could also trigger high memory/CPU usage, presenting a Denial of Service (DoS) vulnerability.
**Learning:** Security parameters must be validated directly at the endpoint boundary. Even if a backend database query natively accepts limit values, unexpected edge-case parameters (such as negative or overly large integers) can alter query semantics or exhaust server resources. Furthermore, complex polyglot testing suites that reload or clear modules from `sys.modules` can result in duplicate configuration singleton instances, requiring robust fixture overrides to locate and set test keys across all reloaded module references.
**Prevention:** Always perform strict upper and lower bounds checks on all incoming user-controlled pagination and search limit inputs before passing them to queries, returning 400 Bad Request on failure.

## 2026-07-28 - [Unbounded Compression Input Length and Batch Size DoS]
**Vulnerability:** The compression endpoints `/api/compression/compress`, `/api/compression/batch`, and `/api/compression/analyze` in `packages/openmemory-js` lacked any validation on the length of input `text` or size of `texts` arrays. A malicious actor could submit excessively large payloads (e.g., several megabytes of text or massive arrays), causing high CPU utilization, high memory usage, and eventually an Out of Memory (OOM) crash or server thread-blocking (Denial of Service).
**Learning:** Utilities that perform resource-intensive tasks such as semantic or syntactic compression must always restrict client-supplied input sizes. Relying on default framework parsing without logical bounds exposes endpoints to simple resource-exhaustion exploits.
**Prevention:** Always enforce strict validation schemas with reasonable length limits (e.g., `max_length: 200_000` characters) and batch size limits (e.g., `max_items: 100`) at the handler entry point before passing them down to compression or processing engines.

## 2026-07-29 - [Unbounded Query Parameter Hours in Dashboard Timeline and Maintenance Endpoints]
**Vulnerability:** The `/dashboard/sectors/timeline` and `/dashboard/maintenance` routes in `packages/openmemory-js` parsed the `hours` query parameter without any type, bounds, or sign validation. A malicious user could submit negative values (calculating a future timestamp range) or excessively large values (triggering massive database scans or integer overflow, resulting in a Denial of Service).
**Learning:** Query parameters that control database search intervals or aggregation windows can easily cause resource exhaustion (DoS) if they are not constrained to sensible thresholds on the server side. Additionally, inline parsing of temporal controls can increase Cognitive Complexity in handlers.
**Prevention:** Extract parsing and validation of temporal query parameters (using secure methods like `Number.parseInt` instead of global `parseInt`) into clean top-level helper functions, keeping routes below Sonar's Cognitive Complexity limits and strictly enforcing input boundaries.

## 2026-07-30 - [Cross-Tenant Data Leakage in Temporal Graph Timeline and Volatility Queries]
**Vulnerability:** The temporal graph timeline queries (`get_subject_timeline`, `get_predicate_timeline`, and `compare_time_points`) and volatility queries (`get_volatile_facts`) did not accept or enforce tenant isolation (`user_id` / `tenant`) in their underlying SQL statements. Consequently, they returned raw timeline data and volatility distributions across all database rows, exposing sensitive facts belonging to other tenants. The application-level post-hoc filtering attempt in the HTTP handlers was completely ineffective because the returned `TimelineEntry` structure did not select or contain the owner's `user_id`.
**Learning:** Performing database queries without scoping them to the authenticated tenant identity, and then attempting post-hoc filtering at the application layer on structures that lack ownership fields, results in complete authorization bypasses and full cross-tenant data leaks.
**Prevention:** Always accept, propagate, and enforce strict tenant-isolation criteria (`user_id`) in all SQL query statements, and perform pagination, sorting, and aggregation exclusively within database-level, tenant-isolated parameters.

## 2026-08-01 - [Multi-Tenant Statistics Leakage in Temporal Fact Queries]
**Vulnerability:** The `/api/temporal/stats` endpoint query counters `get_active_facts_count` and `get_total_facts_count` queried the database without any scoping parameters, returning global counts of temporal facts in the system to any authenticated tenant. This introduced metadata leakage across tenants.
**Learning:** High-level metrics or diagnostic queries can easily overlook tenant scoping, especially when metrics are initially implemented as simple global aggregates. Even if no individual records are returned, statistical and metadata aggregates can leak active system size, frequency of updates, or tenant activity levels.
**Prevention:** Always design database aggregate counters to accept an optional `user_id` / tenant identifier. Filter the counts on the tenant identity by default, restricting global views to explicit, highly-privileged admin roles.

## 2026-08-02 - [Unauthenticated Information Disclosure on System Diagnostic Health Endpoint]
**Vulnerability:** The `/dashboard/health` endpoint was configured as a public endpoint bypassing API key validation, leaking sensitive host-level details (including process memory heap usage, platform type, and process PID) to any unauthenticated public client.
**Learning:** Diagnostic health routes (like `/dashboard/health`) are sometimes grouped with public, unauthenticated standard health-check routes (like `/health`) under simple bypass configurations, mistakenly exposing internal process/system details instead of basic application-level service availability.
**Prevention:** Always separate public application status checks (e.g. `/health`, which only verify that the service is running) from detailed system resource and process diagnostic monitors (e.g. `/dashboard/health`), and strictly secure diagnostic routes with tenant authentication and administrator authorization.

## 2026-08-03 - [Raw Exception Detail Leakage and Status Code Misclassification in LangGraph Routes]
**Vulnerability:** The `/lgm/*` endpoints (`/lgm/store`, `/lgm/retrieve`, `/lgm/context`, and `/lgm/reflection`) caught all runtime exceptions and returned `res.status(400).json({ err: "lgm_<action>_failed", message: (e as Error).message })`. This exposed internal server/database error details to untrusted clients and misclassified server-side exceptions as HTTP 400 Bad Request instead of HTTP 500.
**Learning:** Returning `(e as Error).message` in generic catch blocks without checking exception types leaks sensitive internal implementation details (e.g. database traces, file paths, or third-party service errors) and misrepresents internal failures as client-side input errors.
**Prevention:** Always differentiate input validation errors (`z.ZodError`, returning HTTP 400 with generic `"Validation failed"`) from internal server exceptions (returning HTTP 500 with generic `"internal"` messages), while logging full error details server-side (`console.error`).

## 2026-08-04 - [Multi-Tenant Isolation Bypass in Python MCP Server Tools]
**Vulnerability:** The `openmemory_query`, `openmemory_store`, and `openmemory_list` MCP tool call handlers in `packages/openmemory-py/src/openmemory/ai/mcp.py` extracted `user_id` directly from tool input arguments without validating against the session tenant context using `_resolve_mcp_tenant`. Consequently, callers could pass arbitrary `user_id` values to query or inject memories/facts across tenants, or omit `user_id` to retrieve un-partitioned database history.
**Learning:** Secondary protocol adapters (such as MCP tool handlers) can easily bypass tenant isolation if individual tool functions extract payload user identifiers directly instead of passing input arguments through centralized session tenant resolution helpers.
**Prevention:** Always resolve and validate input `user_id` parameters against the bound session tenant using `_resolve_mcp_tenant` before executing memory search, store, or history operations in MCP server tool handlers.
