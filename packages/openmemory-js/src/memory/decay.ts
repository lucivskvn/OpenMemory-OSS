import {
    q,
    all_async,
    run_async,
    memories_table,
    vector_store,
    log_maint_op,
} from "../core/db";
import { env } from "../core/config";
import { now } from "../utils";
import { clamp_f } from "../utils/math";
import {
    compress_vector,
    compress_summary,
    fingerprint_mem,
} from "./decay_utils";

interface DecayCfg {
    threads: number;
    cold_threshold: number;
    reinforce_on_query: boolean;
    regeneration_enabled: boolean;
    max_vec_dim: number;
    min_vec_dim: number;
    summary_layers: number;
    lambda_hot: number;
    lambda_warm: number;
    lambda_cold: number;
    time_unit_ms: number;
}

const cfg: DecayCfg = {
    threads: env.decay_threads || 4,
    cold_threshold: env.decay_cold_threshold || 0.25,
    reinforce_on_query: true,
    regeneration_enabled: true,
    max_vec_dim: env.max_vector_dim || 1536,
    min_vec_dim: env.min_vector_dim || 64,
    summary_layers: Math.min(3, Math.max(1, env.summary_layers || 3)),
    lambda_hot: 0.005,
    lambda_warm: 0.02,
    lambda_cold: 0.05,
    time_unit_ms: 86_400_000,
};

let last_decay = 0;
const cooldown = 60000;
let active_q = 0;

export const inc_q = () => active_q++;
export const dec_q = () => (active_q = Math.max(0, active_q - 1));

const tick = () => new Promise((r) => setTimeout(r, 0));

const pick_tier = (m: any, now_ts: number): "hot" | "warm" | "cold" => {
    const dt = Math.max(0, now_ts - (m.last_seen_at || m.updated_at || now_ts));
    const recent = dt < 6 * 86_400_000;
    const high = (m.coactivations || 0) > 5 || (m.salience || 0) > 0.7;
    if (recent && high) return "hot";
    if (recent || (m.salience || 0) > 0.4) return "warm";
    return "cold";
};

const chunkz = <T>(arr: T[], n: number): T[][] => {
    const res: T[][] = [];
    for (let i = 0; i < n; i++) res.push([]);
    for (let i = 0; i < arr.length; i++) res[i % n].push(arr[i]);
    return res.filter((x) => x.length > 0);
};

const safe_clamp = (val: number | undefined, def: number) => {
    const v = typeof val === "number" ? val : def;
    return Math.max(0, Math.min(1, v));
};

const sleep_local = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const apply_decay = async () => {
    if (active_q > 0) {
        console.log(`[decay] skipped - ${active_q} active queries`);
        return;
    }
    const now_ts = Date.now();
    if (now_ts - last_decay < cooldown) {
        console.log(
            `[decay] skipped - cooldown active (${((cooldown - (now_ts - last_decay)) / 1000).toFixed(0)}s remaining)`,
        );
        return;
    }
    last_decay = now_ts;
    const t0 = performance.now();

    const segments = await q.get_segments.all(undefined, undefined, true);
    let tot_proc = 0,
        tot_chg = 0,
        tot_comp = 0,
        tot_fp = 0;
    const tier_counts = { hot: 0, warm: 0, cold: 0 };

    for (const seg of segments) {
        const seg_start_proc = tot_proc;
        try {
            const segment = seg.segment;
            const rows = await all_async(
                "select id,user_id,project_id,content,summary,salience,decay_lambda,last_seen_at,updated_at,primary_sector,coactivations,feedback_score from memories where segment=?",
                [segment],
            );

            const decay_ratio = env.decay_ratio;
            const batch_sz = Math.max(1, Math.floor(rows.length * decay_ratio));
            const start_idx = Math.floor(
                Math.random() * Math.max(1, rows.length - batch_sz + 1),
            );
            const batch = rows.slice(start_idx, start_idx + batch_sz);

            const parts = chunkz(batch, cfg.threads);

            const results = await Promise.allSettled(
                parts.map(async (part) => {
                    for (const m of part) {
                        const tier = pick_tier(m, now_ts);
                        tier_counts[tier]++;

                        const lam =
                            tier === "hot"
                                ? cfg.lambda_hot
                                : tier === "warm"
                                  ? cfg.lambda_warm
                                  : cfg.lambda_cold;
                        const dt = Math.max(
                            0,
                            (now_ts - (m.last_seen_at || m.updated_at)) /
                                cfg.time_unit_ms,
                        );
                        const act = Math.max(0, m.coactivations || 0);
                        const sal = clamp_f(
                            (m.salience || 0.5) * (1 + Math.log1p(act)),
                            0,
                            1,
                        );
                        const f = Math.exp(-lam * (dt / (sal + 0.1)));

                        let new_sal = safe_clamp(sal * f, m.salience || 0);
                        let new_feedback = safe_clamp(m.feedback_score, 0);

                        let changed =
                            Math.abs(new_sal - (m.salience || 0)) > 0.001 ||
                            Math.abs(new_feedback - (m.feedback_score || 0)) >
                                0.001;
                        let compressed = false;
                        let fingerprinted = false;

                        if (f < 0.7) {
                            const sector = m.primary_sector || "semantic";
                            const vec_row = await vector_store.getVector(
                                m.id,
                                sector,
                                m.user_id || undefined,
                            );

                            if (vec_row && vec_row.vector) {
                                const vec =
                                    typeof vec_row.vector === "string"
                                        ? JSON.parse(vec_row.vector)
                                        : vec_row.vector;
                                const before_len = Array.isArray(vec)
                                    ? vec.length
                                    : 0;

                                if (before_len > 0) {
                                    const new_vec = compress_vector(
                                        vec,
                                        f,
                                        cfg.min_vec_dim,
                                        cfg.max_vec_dim,
                                    );
                                    const new_summary = compress_summary(
                                        m.summary || m.content || "",
                                        f,
                                        cfg.summary_layers,
                                    );

                                    if (new_vec.length < before_len) {
                                        await vector_store.storeVector(
                                            m.id,
                                            sector,
                                            new_vec,
                                            new_vec.length,
                                            m.user_id || undefined,
                                            m.project_id || undefined,
                                        );
                                        compressed = true;
                                        tot_comp++;
                                    }

                                    if (new_summary !== (m.summary || "")) {
                                        await run_async(
                                            "update memories set summary=? where id=?",
                                            [new_summary, m.id],
                                        );
                                    }
                                }
                            }
                            changed = true;
                        }

                        if (f < Math.max(0.3, cfg.cold_threshold)) {
                            const sector = m.primary_sector || "semantic";
                            const fp = fingerprint_mem(m, cfg.max_vec_dim);
                            await vector_store.storeVector(
                                m.id,
                                sector,
                                fp.vector,
                                fp.vector.length,
                                m.user_id || undefined,
                                m.project_id || undefined,
                            );
                            await run_async(
                                "update memories set summary=? where id=?",
                                [fp.summary, m.id],
                            );
                            fingerprinted = true;
                            tot_fp++;
                            changed = true;
                        }

                        if (changed) {
                            await run_async(
                                `update ${memories_table} set salience=?,feedback_score=?,updated_at=? where id=?`,
                                [new_sal, new_feedback, now(), m.id],
                            );
                            tot_chg++;
                        }

                        tot_proc++;
                        await tick();
                    }
                }),
            );
            const firstError = results.find((r) => r.status === "rejected");
            if (firstError) throw (firstError as PromiseRejectedResult).reason;

            if (seg !== segments[segments.length - 1]) {
                await sleep_local(env.decay_sleep_ms);
            }
        } finally {
            await log_maint_op("decay", tot_proc - seg_start_proc);
        }
    }

    const tot = performance.now() - t0;

    console.error(
        `[decay-2.0] ${tot_chg}/${tot_proc} | tiers: hot=${tier_counts.hot} warm=${tier_counts.warm} cold=${tier_counts.cold} | compressed=${tot_comp} fingerprinted=${tot_fp} | ${tot.toFixed(1)}ms across ${segments.length} segments`,
    );
};

export const on_query_hit = async (
    mem_id: string,
    sector: string,
    reembed?: (text: string) => Promise<number[]>,
) => {
    if (!cfg.regeneration_enabled && !cfg.reinforce_on_query) return;

    const m = await q.get_mem.get(mem_id);
    if (!m) return;

    let updated = false;

    if (cfg.regeneration_enabled && reembed) {
        const vec_row = await vector_store.getVector(
            mem_id,
            sector,
            m.user_id || undefined,
        );
        if (vec_row && vec_row.vector) {
            const vec =
                typeof vec_row.vector === "string"
                    ? JSON.parse(vec_row.vector)
                    : vec_row.vector;
            if (Array.isArray(vec) && vec.length <= 64) {
                try {
                    const base = m.summary || m.content || "";
                    const new_vec = await reembed(base);
                    await vector_store.storeVector(
                        mem_id,
                        sector,
                        new_vec,
                        new_vec.length,
                        m.user_id || undefined,
                        m.project_id || undefined,
                    );
                    updated = true;
                } catch (e) {}
            }
        }
    }

    if (cfg.reinforce_on_query) {
        const new_sal = clamp_f((m.salience || 0.5) + 0.5, 0, 1);
        await run_async(
            `update ${memories_table} set salience=?,last_seen_at=? where id=?`,
            [new_sal, now(), mem_id],
        );
        updated = true;
    }

    if (updated) {
        console.error(`[decay-2.0] regenerated/reinforced memory ${mem_id}`);
    }
};
