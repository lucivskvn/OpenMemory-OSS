# Major Upgrade Plan

This document outlines a staged plan to upgrade larger, potentially breaking dependencies with a safe rollout strategy.

Targets:
- openai -> 6.x (Major) — changes to client API/response shapes, update embedding call sites and tests.
- zod -> 4.x (Major) — API changes, revalidate parsing/transformers in `core/cfg.ts` and other modules.
- react -> 19.x (Major) — Next.js compatibility check and component tests.

Plan:
1. Create a dedicated branch per major upgrade (e.g., `upgrade/openai-6`, `upgrade/zod-4`).
2. Update package and lockfile, run `bun install`.
3. Run full test suite (backend + SDKs + dashboard typecheck). Fix all breaking changes with targeted commits.
4. Add migration notes and deprecation fixes in code (e.g., adapter layer for OpenAI client differences).
5. Deploy to staging (canary) and run manual QA checklists: ingest, reflect, HSG queries, dashboard flows.
6. Monitor for 48–72 hours, roll back on regressions.

CI/Automation:
- Each branch must include: updated `package.json`, `bun.lock`, passing tests, and a short migration note in PR description.

Rollback:
- Use git to revert the upgrade branch or restore from a DB backup for migration-specific changes.

Risks:
- openai v6: embedding/response/API changes require code updates across `embed.ts` and `ops/extract.ts`.
- zod v4: transform semantics changed; re-validate configs and tests.
- react 19: minor API surface changes; run Next build and component smoke tests.

Suggested next immediate step: open separate branches for each major upgrade and start with `openai` due to its direct runtime impact on embedding logic and tests.
