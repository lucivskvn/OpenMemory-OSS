# Sentinel's Journal - CRITICAL SECURITY LEARNINGS

## 2025-02-14 - Server-Side Request Forgery (SSRF) in ExtractURL and Web Crawler
**Vulnerability:** The `extractURL` and `web_crawler_source` functions fetched arbitrary user-supplied URLs without any validation of their destination. This allowed potential SSRF attacks, enabling users/attackers to hit internal/loopback ports, local subnets (RFC 1918), and cloud metadata endpoints (e.g. 169.254.169.254).
**Learning:** Raw fetches to user-controlled URLs present a severe SSRF risk, especially in microservice/agentic architectures where the agent has access to private network resources. DNS rebinding and multi-A-record responses must be resolved and checked comprehensively.
**Prevention:** Always validate protocol (strictly `http:` and `https:`) and resolve user-controlled URLs to their final IP addresses. Verify that neither the input domain/IP nor any of the DNS-resolved IP addresses belong to loopback, private, link-local, or multicast address ranges, failing closed on any errors.

## 2025-02-14 - IPv6 Subnet Parsing Gaps in SSRF Protection
**Vulnerability:** Simple string-based prefix checking (e.g., `.startsWith("fd00:")` or `.startsWith("fc00:")`) to identify private IPv6 unique local addresses (ULA) can be bypassed. For instance, a private ULA starting with `fd12:` will not match a simple `fd00:` check.
**Learning:** IPv6 subnets are designated by bitmasks (e.g., `fc00::/7`, `fe80::/10`, `ff00::/8`). Checking them requires parsing the first block as a hex integer and verifying that the numeric value falls within the proper boundaries.
**Prevention:** To validate IPv6 private subnets accurately:
- `fc00::/7` (ULA): verify the first group is between `0xfc00` and `0xfdff`.
- `fe80::/10` (Link-local): verify the first group is between `0xfe80` and `0xfebf`.
- `ff00::/8` (Multicast): verify the first group is between `0xff00` and `0xffff`.

## 2025-02-14 - Timing Attack and Key Length Leaks in API Key Verification
**Vulnerability:** Standard comparisons (e.g., `provided.length === expected.length` followed by comparing the actual strings) leak key length information through the early length-mismatch exit, making the system vulnerable to timing side-channel attacks.
**Learning:** Constant-time comparison is necessary to prevent timing attacks. However, simply using `crypto.timingSafeEqual` directly can throw on different-length inputs, tempting developers to use unsafe length guards.
**Prevention:** Hash both inputs using a cryptographically secure hash function (e.g., SHA-256) first. Since the digests are always identical in length, they can be compared using `crypto.timingSafeEqual` safely without any pre-comparison length guards, eliminating both length leakage and timing side-channels.
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
