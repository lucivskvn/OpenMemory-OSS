# OpenMemory Agentic Architecture & Compliance Manifest

This manifest defines the absolute structural boundaries, invariants, and compliance mapping required for all automated agents, bots, and LLM-assisted workflows interacting with the OpenMemory workspace.

These rules supersede any generalized AI logic. All operations must strictly adhere to these standards.

## 1. Structural Workspace Rules

* **Domain Isolation**: Side effects (like clustering, sync logic, and remote mutability) must be isolated within the core domain layer (`src/core/memory.ts`) and must never be exposed or executed directly within the HTTP transport/router layer.
* **Type Safety**: Strict TypeScript typing is enforced codebase-wide. The use of implicit or explicit `any` is forbidden.
* **Runtime**: The project natively uses Bun. Rely on Bun-native APIs (e.g., `Bun.file`, native `fetch`) over Node.js polyfills where possible. Dependency management and execution must use `bun install`, `bun test`, and `bun build`.
* **Database**: The primary database backend is Turso (libSQL). Configuration logic is strictly centralized via Zod validation in `src/core/config.ts`.

## 2. Matryoshka Prefix-Slicing Invariants

When manipulating embedding vectors, Matryoshka representation models require deterministic dimension truncation to remain semantically valid.

* **Truncation**: You must use explicit prefix slicing via `.slice(0, target_dim)` when down-sampling vector dimensions.
* **Normalization**: Every truncated vector must be re-normalized. Mandatory `normalize()` calls must be executed immediately following any `.slice()` operation to protect the vector space embedding integrity. Failure to do so will corrupt cosine similarity searches.

## 3. Remote Turso Transaction Pooling Requirements

To optimize latency and prevent race conditions when interacting with remote Turso instances, database mutations must be pooled.

* **Transaction Boundaries**: All write operations must be wrapped in atomic transaction boundaries.
* **Implementation**: You must use `transaction.begin()` to initiate the pool and `transaction.commit()` to finalize.
* **Batch Execution**: Individual remote queries should be aggregated into an atomic remote `client.batch(..., "write")` call within the transaction boundary.

## 4. Supabase RLS Standards

For any deployments or integrations utilizing Supabase as a data layer or auth provider:

* **Default Deny**: All tables must have Row Level Security (RLS) enabled by default (`ALTER TABLE tablename ENABLE ROW LEVEL SECURITY;`).
* **Explicit Policies**: Access must be explicitly granted via bounded policies. Unrestricted `true` policies are strictly prohibited.
* **Tenant Isolation**: Operations accessing memories must strictly validate the `tenant_id` or `user_id` mapped from the authenticated JWT against the row-level data.

## 5. Context7 Window Restrictions & Render MCP

When deploying the native Model Context Protocol (MCP) server via Render or interacting with Context7:

* **Window Restrictions**: Context7 token window bounds are strictly enforced to prevent context exhaustion attacks. System prompts and retrieved context must dynamically truncate to fit within the `OM_MAX_CONTEXT_TOKENS` limit.
* **Proxy Configuration**: The Render MCP deployment relies on reverse-proxying. Code must respect the `X-Forwarded-For` and `X-Forwarded-Proto` headers for IP tracing and protocol verification.
* **Token Verification**: Access to the `/mcp` route parameters and proxy endpoints mandates strict Bearer token verification against `OM_MCP_AUTH_TOKEN`. Unauthenticated bypasses are explicitly forbidden.

## 6. Code-to-Compliance Mapping Matrices

### OWASP Top 10 Mapping
* **A01:2021-Broken Access Control**: Enforced via Supabase RLS standards (Section 4) and MCP Token Verification (Section 5).
* **A03:2021-Injection**: Mitigated by parameterized Turso queries via `client.batch` (Section 3).
* **A06:2021-Vulnerable and Outdated Components**: Mitigated by CI pipelines requiring successful Snyk and Semgrep gating.

### MITRE ATT&CK Mapping
* **T1190 (Exploit Public-Facing Application)**: Mitigated by mandatory MCP Token Verification and Render proxy header sanitization (Section 5).
* **T1566 (Phishing) / Data Poisoning**: Mitigated by Matryoshka slicing and normalization invariants preventing malformed vector payload injection (Section 2).

### MITRE ATLAS Mapping
* **AML.T0002 (Data Poisoning)**: Vector injection bounds checked via `target_dim` enforcement and `normalize()` validation (Section 2).
* **AML.T0040 (ML Model Access)**: Direct model query inference bounded by Context7 Window Restrictions preventing context exhaustion and extraction attacks (Section 5).
* **AML.T0031 (Evasion of ML Detectors)**: Semgrep and Desloppify CI gating ensures mechanical health and detects prompt/code slop evasion attempts.
