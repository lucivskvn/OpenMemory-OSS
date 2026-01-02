import { q, log_maint_op, Memory } from "../core/db";
import { add_hsg_memory } from "./hsg";
import { env } from "../core/cfg";
import { j } from "../utils";

const sim = (t1: string, t2: string): number => {
    const s1 = new Set(t1.toLowerCase().split(/\s+/).filter(x => x.length > 0));
    const s2 = new Set(t2.toLowerCase().split(/\s+/).filter(x => x.length > 0));
    if (s1.size === 0 || s2.size === 0) return 0;

    let inter = 0;
    for (const token of s1) {
        if (s2.has(token)) inter++;
    }
    const union = new Set([...s1, ...s2]).size;
    return union > 0 ? inter / union : 0;
};

const cluster = (mems: Memory[]): { mem: Memory[], n: number }[] => {
    const cls: { mem: Memory[], n: number }[] = [];
    const used = new Set<string>();
    for (const m of mems) {
        if (
            used.has(m.id) ||
            m.primary_sector === "reflective"
        )
            continue;

        let meta: any = {};
        try {
            meta = m.meta ? (typeof m.meta === 'string' ? JSON.parse(m.meta) : m.meta) : {};
        } catch (e) { /* ignore */ }

        if (meta.consolidated) continue;
        const c = { mem: [m], n: 1 };
        used.add(m.id);
        for (const o of mems) {
            if (used.has(o.id) || m.primary_sector !== o.primary_sector)
                continue;
            if (sim(m.content, o.content) > 0.8) {
                c.mem.push(o);
                c.n++;
                used.add(o.id);
            }
        }
        if (c.n >= 2) cls.push(c);
    }
    return cls;
};

const sal = (c: { mem: Memory[], n: number }): number => {
    const now = Date.now();
    const p = c.n / 10;
    const r =
        c.mem.reduce(
            (s: number, m: Memory) =>
                s +
                Math.exp(-(now - Number(m.created_at)) / 43200000),
            0,
        ) / c.n;
    const e = c.mem.some(
        (m: Memory) => {
            const sectors = (m.tags ? j(m.tags) : []) as string[];
            return sectors.includes("emotional");
        }
    )
        ? 1
        : 0;
    return Math.min(1, 0.6 * p + 0.3 * r + 0.1 * e);
};

const summ = (c: { mem: Memory[], n: number }): string => {
    const sec = c.mem[0].primary_sector;
    const n = c.n;
    const txt = c.mem.map((m: Memory) => m.content.substring(0, 60)).join("; ");
    return `${n} ${sec} pattern: ${txt.substring(0, 200)}`;
};

const process_reflection_sources = async (ids: string[], user_id: string | undefined) => {
    const now = Date.now();
    for (const id of ids) {
        const m = await q.get_mem.get(id, user_id);
        if (m) {
            let meta: any = {};
            try {
                meta = typeof m.meta === 'string' ? JSON.parse(m.meta || "{}") : (m.meta || {});
            } catch (e) { /* ignore */ }
            meta.consolidated = true;
            // Combined update for marking consolidated and boosting salience
            await q.upd_mem.run(
                m.content,
                m.tags || "",
                JSON.stringify(meta),
                now,
                id,
                user_id,
            );
            await q.upd_seen.run(
                id,
                Number(m.last_seen_at) || now,
                Math.min(1, (m.salience ?? 0) * 1.1),
                now,
                user_id,
            );
        }
    }
};

export const run_reflection = async () => {
    if (env.verbose) console.error("[REFLECT] Starting reflection job...");
    const min = env.reflect_min || 20;

    // Fetch all active users to ensure multi-tenant isolation
    const users = await q.get_active_users.all();
    if (env.verbose) console.error(`[REFLECT] Found ${users.length} active users`);

    let totalCreated = 0;
    let totalClusters = 0;

    for (const { user_id } of users) {
        if (env.verbose) console.error(`[REFLECT] Processing user: ${user_id}`);
        const mems = (await q.all_mem_by_user.all(user_id, 100, 0)) as Memory[];

        if (mems.length < min) {
            if (env.verbose) console.error(`[REFLECT] User ${user_id}: Not enough memories (${mems.length}), skipping`);
            continue;
        }

        const cls = cluster(mems);
        if (env.verbose) console.error(`[REFLECT] User ${user_id}: Clustered into ${cls.length} groups`);

        for (const c of cls) {
            const txt = summ(c);
            const s = sal(c);
            const src = c.mem.map((m: Memory) => m.id);
            const meta = {
                type: "auto_reflect",
                sources: src,
                freq: c.n,
                at: new Date().toISOString(),
                user_id, // Explicitly include user_id in metadata
            };
            if (env.verbose) {
                console.error(
                    `[REFLECT] User ${user_id}: Creating reflection: ${c.n} memories, salience=${s.toFixed(3)}, sector=${c.mem[0].primary_sector}`,
                );
            }
            // add_hsg_memory handles user_id internally via tags/meta if passed correctly
            await add_hsg_memory(txt, j(["reflect:auto"]), meta, user_id as string);
            await process_reflection_sources(src, user_id as string);
            totalCreated++;
        }
        totalClusters += cls.length;
    }

    if (totalCreated > 0) await log_maint_op("reflect", totalCreated);
    if (env.verbose) console.error(`[REFLECT] Job complete: created ${totalCreated} reflections across users`);
    return { created: totalCreated, clusters: totalClusters };
};

let timer: NodeJS.Timeout | null = null;

export const start_reflection = () => {
    if (!env.auto_reflect || timer) return;
    const int = (env.reflect_interval || 10) * 60000;
    timer = setInterval(
        () => run_reflection().catch((e) => console.error("[REFLECT]", e)),
        int,
    );
    if (env.verbose) console.error(`[REFLECT] Started: every ${env.reflect_interval || 10}m`);
};

export const stop_reflection = () => {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
};
