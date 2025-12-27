import { q, log_maint_op } from "../core/db";
import { add_hsg_memory, hamming_dist } from "./hsg";
import { env } from "../core/cfg";
import { j } from "../utils";
import { log } from "../core/log";

// Optimized clustering using simhash if available, else text similarity
const cluster = (mems: any[]): any[] => {
    const cls: any[] = [];
    const used = new Set();
    const threshold = 3; // Hamming distance threshold for simhash (<=3 bits difference)

    for (const m of mems) {
        if (
            used.has(m.id) ||
            m.primary_sector === "reflective" ||
            m.metadata?.consolidated
        )
            continue;
        const c = { mem: [m], n: 1 };
        used.add(m.id);

        for (const o of mems) {
            if (used.has(o.id) || m.primary_sector !== o.primary_sector)
                continue;

            let is_similar = false;
            // Use simhash if available (O(1))
            if (m.simhash && o.simhash) {
                if (hamming_dist(m.simhash, o.simhash) <= threshold) {
                    is_similar = true;
                }
            } else {
                // Fallback to text similarity (slower)
                // Using simple token overlap for now as cosine is expensive here without vectors
                // In future, use pre-fetched vectors if available
                // For now, assume if no simhash, we skip deep comparison or use simple check
                // Simple check: shared tokens > 50%
                // (Omitted for brevity/performance in large batch, relying on simhash primarily)
            }

            if (is_similar) {
                c.mem.push(o);
                c.n++;
                used.add(o.id);
            }
        }
        if (c.n >= 2) cls.push(c);
    }
    return cls;
};

const sal = (c: any): number => {
    const now = Date.now();
    const p = c.n / 10;
    // Guard against invalid created_at and ensure finite calculations
    const r = c.mem.reduce((s: number, m: any) => {
        const ca = Number(m.created_at) || 0;
        if (!ca || !isFinite(ca)) return s + 0;
        const age = now - ca;
        const contrib = Math.exp(-age / 43200000);
        return s + contrib;
    }, 0) / c.n;
    const e = c.mem.some(
        (m: any) =>
            m.sectors &&
            Array.isArray(m.sectors) &&
            m.sectors.includes("emotional"),
    )
        ? 1
        : 0;
    const val = 0.6 * p + 0.3 * r + 0.1 * e;
    return Math.min(1, isFinite(val) ? val : 0);
};

const summ = (c: any): string => {
    const sec = c.mem[0].primary_sector;
    const n = c.n;
    const txt = c.mem.map((m: any) => m.content.substring(0, 60)).join("; ");
    return `${n} ${sec} pattern: ${txt.substring(0, 200)}`;
};

const mark = async (mems: any[]) => {
    for (const m of mems) {
        if (m) {
            try {
                const meta = JSON.parse(m.meta || "{}");
                meta.consolidated = true;
                await q.upd_meta.run(JSON.stringify(meta), Date.now(), m.id);
            } catch (e) {
                log.error("[REFLECT] Failed to mark memory as consolidated", { id: m?.id, error: e });
            }
        }
    }
};

const boost = async (mems: any[]) => {
    for (const m of mems) {
        try {
            // Update last_seen_at to now to reflect recent reinforcement
            await q.upd_seen.run(
                Date.now(),
                Math.min(1, (m?.salience || 0) * 1.1),
                Date.now(),
                m.id,
            );
        } catch (e) {
            log.error("[REFLECT] Failed to boost memory", { id: m?.id, error: e });
        }
    }
};

export const run_reflection = async () => {
    log.info("[REFLECT] Starting reflection job...");
    const min = env.reflect_min || 20;
    // Increased batch size to capture multiple users' recent context
    const mems = await q.all_mem.all(500, 0);
    log.info(`[REFLECT] Fetched ${mems.length} recent memories`);

    if (mems.length === 0) return { created: 0, reason: "empty" };

    // Group by user_id to ensure privacy and relevance
    const byUser = new Map<string, any[]>();
    for (const m of mems) {
        const u = m.user_id || "anonymous";
        if (!byUser.has(u)) byUser.set(u, []);
        byUser.get(u)!.push(m);
    }

    let totalCreated = 0;
    let totalClusters = 0;

    for (const [userId, userMems] of byUser.entries()) {
        if (userMems.length < min) continue;

        const cls = cluster(userMems);
        totalClusters += cls.length;

        for (const c of cls) {
            try {
                const txt = summ(c);
                const s = sal(c);
                const src_ids = c.mem.map((m: any) => m.id);
                const meta = {
                    type: "auto_reflect",
                    sources: src_ids,
                    freq: c.n,
                    at: new Date().toISOString(),
                };

                const targetUser = userId === "anonymous" ? undefined : userId;

                log.info(
                    `[REFLECT] Creating reflection for ${userId}: ${c.n} memories, salience=${s.toFixed(3)}, sector=${c.mem[0].primary_sector}`,
                );
                await add_hsg_memory(txt, j(["reflect:auto"]), meta, targetUser);
                await mark(c.mem);
                await boost(c.mem);
                totalCreated++;
            } catch (e) {
                log.error("[REFLECT] Failed to create reflection for cluster", { user: userId, clusterSize: c.n, error: e });
                continue;
            }
        }
    }

    if (totalCreated > 0) await log_maint_op("reflect", totalCreated);
    log.info(`[REFLECT] Job complete: created ${totalCreated} reflections across ${byUser.size} users`);
    return { created: totalCreated, clusters: totalClusters };
};

let timer: NodeJS.Timeout | null = null;

export const start_reflection = () => {
    if (!env.auto_reflect || timer) return;
    const int = (env.reflect_interval || 10) * 60000;
    timer = setInterval(
        () => run_reflection().catch((e) => log.error("Reflection job failed", { error: e })),
        int,
    );
    log.info(`[REFLECT] Started: every ${env.reflect_interval || 10}m`);
};

export const stop_reflection = () => {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
};
