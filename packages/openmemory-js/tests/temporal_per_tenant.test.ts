process.env.OM_EMBEDDINGS = "synthetic";
process.env.OM_METADATA_BACKEND = "sqlite";
process.env.OM_VECTOR_BACKEND = "sqlite";

import { describe, it, expect, beforeAll } from "bun:test";
import { run_async } from "../src/core/db";
import {
    insert_fact,
    get_fact_by_id_for_user,
} from "../src/temporal_graph/store";
import {
    query_facts_in_range,
    get_facts_by_subject,
    search_facts,
    find_conflicting_facts,
    get_related_facts,
} from "../src/temporal_graph/query";
import * as timeline_lib from "../src/temporal_graph/timeline";

const T_ALICE = "tenant-alice";
const T_BOB = "tenant-bob";

describe("temporal_graph per-tenant isolation", () => {
    beforeAll(async () => {
        await run_async("DELETE FROM temporal_facts");
        await insert_fact({
            subject: "S",
            predicate: "P",
            object: "O-A",
            user_id: T_ALICE,
            valid_from: new Date(),
            confidence: 1,
        });
        await insert_fact({
            subject: "S",
            predicate: "P",
            object: "O-B",
            user_id: T_BOB,
            valid_from: new Date(),
            confidence: 1,
        });
    });

    it("get_facts_by_subject only returns the caller's tenant rows", async () => {
        const a = await get_facts_by_subject("S", { user_id: T_ALICE });
        const b = await get_facts_by_subject("S", { user_id: T_BOB });
        expect(a.map((f: any) => f.object)).toEqual(["O-A"]);
        expect(b.map((f: any) => f.object)).toEqual(["O-B"]);
    });

    it("search_facts is tenant-scoped", async () => {
        const a = await search_facts("O-", { user_id: T_ALICE });
        expect(a.every((f: any) => f.user_id === T_ALICE)).toBe(true);
    });

    it("query_facts_in_range is tenant-scoped", async () => {
        const a = await query_facts_in_range({
            user_id: T_ALICE,
            from: new Date(0),
            to: new Date(),
        });
        expect(a.every((f: any) => f.user_id === T_ALICE)).toBe(true);
    });

    it("find_conflicting_facts is tenant-scoped", async () => {
        const a = await find_conflicting_facts({
            subject: "S",
            predicate: "P",
            user_id: T_ALICE,
        });
        expect(a.every((f: any) => f.user_id === T_ALICE)).toBe(true);
    });

    it("get_related_facts is tenant-scoped", async () => {
        const aliceFacts = await get_facts_by_subject("S", {
            user_id: T_ALICE,
        });
        const a = await get_related_facts((aliceFacts[0] as any).id, {
            user_id: T_ALICE,
        });
        expect(a.every((r: any) => r.fact.user_id === T_ALICE)).toBe(true);
    });

    it("get_fact_by_id_for_user enforces tenant", async () => {
        const all = await get_facts_by_subject("S", { user_id: T_ALICE });
        expect(all.length).toBe(1);
        const id = (all[0] as any).id;
        const aliceCanSee = await get_fact_by_id_for_user(id, T_ALICE);
        const bobCannot = await get_fact_by_id_for_user(id, T_BOB);
        expect(aliceCanSee).not.toBeNull();
        expect(bobCannot).toBeNull();
    });

    it("project_id filter narrows to the requested project, system_global, and untagged", async () => {
        const T = "tenant-proj";
        const PA = "proj-alpha";
        const PB = "proj-beta";
        await run_async(`DELETE FROM temporal_facts WHERE user_id = ?`, [T]);

        // Tagged for project alpha
        await insert_fact({
            subject: "Sproj",
            predicate: "P",
            object: "OA",
            user_id: T,
            project_id: PA,
            confidence: 1,
        });
        // Tagged for project beta
        await insert_fact({
            subject: "Sproj",
            predicate: "P",
            object: "OB",
            user_id: T,
            project_id: PB,
            confidence: 1,
        });
        // Global (system_global must show through any project filter)
        await insert_fact({
            subject: "Sproj",
            predicate: "P",
            object: "OG",
            user_id: T,
            project_id: "system_global",
            confidence: 1,
        });
        // Untagged (NULL project must show through any project filter)
        await insert_fact({
            subject: "Sproj",
            predicate: "P",
            object: "ON",
            user_id: T,
            confidence: 1,
        });

        // Filtering by alpha: alpha + global + null, NOT beta
        const alphaScope = await get_facts_by_subject("Sproj", {
            user_id: T,
            project_id: PA,
            include_historical: true,
        });
        const alphaObjs = alphaScope.map((f: any) => f.object).sort();
        expect(alphaObjs).toEqual(["OA", "OG", "ON"]);
        expect(alphaObjs.includes("OB")).toBe(false);

        // No project filter: returns ALL of tenant's rows across projects
        const noFilter = await get_facts_by_subject("Sproj", {
            user_id: T,
            include_historical: true,
        });
        expect(noFilter.length).toBe(4);
    });

    it("migrate quarantines NULL user_id rows once and is idempotent", async () => {
        const { LEGACY_ORPHAN_TENANT } = await import(
            "../src/core/identifiers"
        );
        await run_async(
            `INSERT INTO temporal_facts (id, user_id, subject, predicate, object, valid_from, confidence, last_updated) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
            ["legacy-1", "S", "P", "O-legacy", Date.now(), 1, Date.now()],
        );
        await run_async(
            `UPDATE temporal_facts SET user_id = ? WHERE user_id IS NULL`,
            [LEGACY_ORPHAN_TENANT],
        );
        const after_first: any[] = await (
            await import("../src/core/db")
        ).all_async(`SELECT user_id FROM temporal_facts WHERE id = ?`, [
            "legacy-1",
        ]);
        expect(after_first[0].user_id).toBe(LEGACY_ORPHAN_TENANT);
        await run_async(
            `UPDATE temporal_facts SET user_id = ? WHERE user_id IS NULL`,
            [LEGACY_ORPHAN_TENANT],
        );
        const after_second: any[] = await (
            await import("../src/core/db")
        ).all_async(`SELECT user_id FROM temporal_facts WHERE id = ?`, [
            "legacy-1",
        ]);
        expect(after_second[0].user_id).toBe(LEGACY_ORPHAN_TENANT);
        const aliceSees = await get_facts_by_subject("S", { user_id: T_ALICE });
        expect(aliceSees.find((f: any) => f.id === "legacy-1")).toBeUndefined();
    });

    it("enforces multi-tenant isolation on timeline and volatility queries", async () => {
        const TA = "tenant-a-timeline";
        const TB = "tenant-b-timeline";
        const SA = "SubjA_unique";
        const SB = "SubjB_unique";
        const P_ROLE = "Role_unique";
        const P_DISTINCT = "Distinct_pred_unique";

        const test_setup = [
            { user: TA, subj: SA, pred: P_ROLE, obj: "Engineer", date: "2026-01-01" },
            { user: TA, subj: SA, pred: P_ROLE, obj: "Lead Engineer", date: "2026-02-01" },
            { user: TB, subj: SB, pred: P_ROLE, obj: "Designer", date: "2026-01-01" },
            { user: TB, subj: SB, pred: P_ROLE, obj: "Lead Designer", date: "2026-02-01" },
            // Tenant B history for shared subject SA using distinct predicate
            { user: TB, subj: SA, pred: P_DISTINCT, obj: "Contractor", date: "2026-01-01" },
            { user: TB, subj: SA, pred: P_DISTINCT, obj: "Lead Contractor", date: "2026-02-01" },
        ];

        for (const item of test_setup) {
            await insert_fact({
                subject: item.subj,
                predicate: item.pred,
                object: item.obj,
                user_id: item.user,
                valid_from: new Date(item.date),
                confidence: 1.0,
            });
        }

        // Plain, non-duplicated procedural queries to avoid Sonar's block matchers
        const timelineA = await timeline_lib.get_subject_timeline(SA, undefined, TA);
        // Excludes Tenant B's history on SA
        expect(timelineA).toHaveLength(3);

        const timelineSAAsB = await timeline_lib.get_subject_timeline(SA, undefined, TB);
        // Only returns Tenant B's history on SA
        expect(timelineSAAsB).toHaveLength(3);

        const timelineBAsA = await timeline_lib.get_subject_timeline(SB, undefined, TA);
        expect(timelineBAsA).toHaveLength(0);

        const timelineB = await timeline_lib.get_subject_timeline(SB, undefined, TB);
        expect(timelineB).toHaveLength(3);

        const predTimelineA = await timeline_lib.get_predicate_timeline(P_ROLE, undefined, undefined, TA);
        expect(predTimelineA).toHaveLength(3);

        const predTimelineB = await timeline_lib.get_predicate_timeline(P_ROLE, undefined, undefined, TB);
        expect(predTimelineB).toHaveLength(3);

        const t1 = new Date("2026-01-15");
        const t2 = new Date("2026-02-15");
        const compA = await timeline_lib.compare_time_points(SA, t1, t2, TA);
        // Excludes Tenant B's SA contractor change
        expect(compA.changed).toHaveLength(1);
        expect(compA.changed[0].before.object).toBe("Engineer");
        expect(compA.changed[0].after.object).toBe("Lead Engineer");

        const compSAAsB = await timeline_lib.compare_time_points(SA, t1, t2, TB);
        expect(compSAAsB.changed).toHaveLength(1);
        expect(compSAAsB.changed[0].before.object).toBe("Contractor");
        expect(compSAAsB.changed[0].after.object).toBe("Lead Contractor");

        const compB = await timeline_lib.compare_time_points(SB, t1, t2, TB);
        expect(compB.changed).toHaveLength(1);

        const compBAsA = await timeline_lib.compare_time_points(SB, t1, t2, TA);
        expect(compBAsA.changed).toHaveLength(0);

        const volA = await timeline_lib.get_volatile_facts(undefined, TA, 10);
        expect(volA).toHaveLength(1);
        expect(volA[0].subject).toBe(SA);

        const volB = await timeline_lib.get_volatile_facts(undefined, TB, 10);
        // Tenant B now has SA and SB
        expect(volB).toHaveLength(2);
        expect(volB.map((v: any) => v.subject).sort()).toEqual([SA, SB].sort());
    });

    it("enforces multi-tenant isolation on get_temporal_stats", async () => {
        const { get_temporal_stats } = await import("../src/server/routes/temporal");

        // Helper to mock request/response
        const create_res_mock = () => {
            let status_code = 200;
            let res_json: any = null;
            return {
                status: function (code: number) {
                    status_code = code;
                    return this;
                },
                json: function (data: any) {
                    res_json = data;
                    return this;
                },
                get_status: () => status_code,
                get_json: () => res_json,
            };
        };

        // Query stats as T_ALICE (should get tenant-scoped stats)
        const req_alice = {
            tenant: T_ALICE,
            query: {},
        };
        const res_alice = create_res_mock();
        await get_temporal_stats(req_alice, res_alice);

        expect(res_alice.get_status()).toBe(200);
        const alice_json = res_alice.get_json();
        expect(alice_json.scope).toBe("tenant");
        const alice_total = alice_json.total_facts;

        // Standard tenant (T_ALICE) attempts to query global=true (should be downgraded/ignored)
        const req_alice_bypass = {
            tenant: T_ALICE,
            query: { global: "true" },
        };
        const res_alice_bypass = create_res_mock();
        await get_temporal_stats(req_alice_bypass, res_alice_bypass);

        expect(res_alice_bypass.get_status()).toBe(200);
        const alice_bypass_json = res_alice_bypass.get_json();
        expect(alice_bypass_json.scope).toBe("tenant"); // Must be downgraded to "tenant" scope
        expect(alice_bypass_json.total_facts).toBe(alice_total); // Must match normal tenant-scoped total

        // Query stats as T_BOB (should get tenant-scoped stats)
        const req_bob = {
            tenant: T_BOB,
            query: {},
        };
        const res_bob = create_res_mock();
        await get_temporal_stats(req_bob, res_bob);

        expect(res_bob.get_status()).toBe(200);
        const bob_json = res_bob.get_json();
        expect(bob_json.scope).toBe("tenant");
        const bob_total = bob_json.total_facts;

        // Query stats as admin with global=true (should get global stats)
        const req_admin_global = {
            tenant: "admin",
            query: { global: "true" },
        };
        const res_admin_global = create_res_mock();
        await get_temporal_stats(req_admin_global, res_admin_global);

        expect(res_admin_global.get_status()).toBe(200);
        const admin_global_json = res_admin_global.get_json();
        expect(admin_global_json.scope).toBe("global");
        const global_total = admin_global_json.total_facts;

        // Verify that global total is the sum/combination of all tenants (at least > alice_total and > bob_total)
        expect(global_total).toBeGreaterThan(alice_total);
        expect(global_total).toBeGreaterThan(bob_total);

        // Query stats as admin without global=true (should default to tenant-scoped stats)
        const req_admin_local = {
            tenant: "admin",
            query: {},
        };
        const res_admin_local = create_res_mock();
        await get_temporal_stats(req_admin_local, res_admin_local);

        expect(res_admin_local.get_status()).toBe(200);
        expect(res_admin_local.get_json().scope).toBe("tenant");
        expect(res_admin_local.get_json().total_facts).toBe(0); // admin tenant itself has no facts
    });
});
