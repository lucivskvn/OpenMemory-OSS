# Sentinel Journal

## 2025-02-17 - [Advanced Memory Dynamics Tenant Isolation Leak]
**Vulnerability:** The advanced memory dynamics server routes (retrieval, spreading activation, trace reinforcement, associative waypoint graph generation) were executing global queries on `memories` and `waypoints` tables without scoping them to the active tenant/user.
**Learning:** Even if helper/operation functions are written without tenant parameters initially (for background or global maintenance reasons), exposing them directly through server endpoints without passing the authenticated tenant parameter leads to massive multi-tenant data leaks and unauthorized direct object references.
**Prevention:** Always enforce `require_tenant` at the HTTP route boundary, validate all client-provided request payloads (including target memory IDs and arrays of memory IDs) against defined schemas and the authenticated tenant scope, and pass the tenant down to all downstream query and retrieval functions.
