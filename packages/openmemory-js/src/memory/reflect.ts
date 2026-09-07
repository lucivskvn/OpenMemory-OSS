import { q, log_maint_op, all_async } from "../core/db";
import { add_hsg_memory } from "./hsg";
import { env } from "../core/config";
import { j } from "../utils";

const sim = (t1: string, t2: string): number => {
    const s1 = new Set(
        t1
            .toLowerCase()
            .split(/\s+/)
            .filter((x) => x.length > 0),
    );
    const s2 = new Set(
        t2
            .toLowerCase()
            .split(/\s+/)
            .filter((x) => x.length > 0),
    );
    if (s1.size === 0 || s2.size === 0) return 0;

    let inter = 0;
    for (const token of s1) {
        if (s2.has(token)) inter++;
    }
    const union = new Set([...s1, ...s2]).size;
    return union > 0 ? inter / union : 0;
};

const cluster = (mems: any[]): any[] => {
    const cls: any[] = [];
    const used = new Set();
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

const sal = (c: any): number => {
    const now = Date.now();
    const p = c.n / 10;
    const r =
        c.mem.reduce(
            (s: number, m: any) =>
                s +
                Math.exp(-(now - new Date(m.created_at).getTime()) / 43200000),
            0,
        ) / c.n;
    const e = c.mem.some(
        (m: any) =>
            m.sectors &&
            Array.isArray(m.sectors) &&
            m.sectors.includes("emotional"),
    )
        ? 1
        : 0;
    return Math.min(1, 0.6 * p + 0.3 * r + 0.1 * e);
};

const summ = (c: any): string => {
    const sec = c.mem[0].primary_sector;
    const n = c.n;
    const txt = c.mem.map((m: any) => m.content.substring(0, 60)).join("; ");
    return `${n} ${sec} pattern: ${txt.substring(0, 200)}`;
};

const mark = async (ids: string[], user_id: string) => {
    const active_user = user_id?.trim();
    if (!active_user) return;
    for (const id of ids) {
        const m = await q.get_mem.get(id);
        if (m && m.user_id === active_user) {
            const meta = JSON.parse(m.meta || "{}");
            meta.consolidated = true;
            await q.upd_mem.run(
                m.content,
                m.tags,
                JSON.stringify(meta),
                Date.now(),
                id,
                active_user,
            );
        }
    }
};

const boost = async (ids: string[], user_id: string) => {
    const active_user = user_id?.trim();
    if (!active_user) return;
    for (const id of ids) {
        const m = await q.get_mem.get(id);
        if (m && m.user_id === active_user) {
            await q.upd_mem.run(m.content, m.tags, m.meta, Date.now(), id, active_user);
            await q.upd_seen.run(
                m.last_seen_at,
                Math.min(1, m.salience * 1.1),
                Date.now(),
                id,
                active_user,
            );
        }
    }
};

export const run_reflection = async (user_id: string, min_override?: number) => {
    const active_user = user_id?.trim();
    if (!active_user) {
        throw new Error("tenant_required: run_reflection requires an authenticated non-empty user_id");
    }

    console.error(`[REFLECT] Starting reflection job...`);
    const min = min_override ?? env.reflect_min ?? 20;
    const mems = await q.all_mem_by_user.all(active_user, 100, 0);
    console.error(
        `[REFLECT] Fetched ${mems.length} memories (min required: ${min})`,
    );
    if (mems.length < min) {
        console.error("[REFLECT] Not enough memories, skipping");
        return { created: 0, reason: "low" };
    }
    const cls = cluster(mems);
    console.error(`[REFLECT] Clustered into ${cls.length} groups`);
    let n = 0;
    for (const c of cls) {
        const txt = summ(c);
        const s = sal(c);
        const src = c.mem.map((m: any) => m.id);
        const meta = {
            type: "auto_reflect",
            sources: src,
            freq: c.n,
            at: new Date().toISOString(),
        };
        console.error(
            `[REFLECT] Creating reflection: ${c.n} memories, salience=${s.toFixed(3)}, sector=${c.mem[0].primary_sector}`,
        );
        await add_hsg_memory(txt, j(["reflect:auto"]), meta, active_user);
        await mark(src, active_user);
        await boost(src, active_user);
        n++;
    }
    if (n > 0) await log_maint_op("reflect", n);
    console.error(`[REFLECT] Job complete: created ${n} reflections`);
    return { created: n, clusters: cls.length };
};

let timer: NodeJS.Timeout | null = null;

export const run_reflection_all_tenants = async (min_override?: number) => {
    const tenant_rows = await all_async(
        "select distinct user_id from memories where user_id is not null and user_id != ''",
    );
    let total_created = 0;
    for (const row of tenant_rows) {
        if (row.user_id?.trim()) {
            const res = await run_reflection(row.user_id.trim(), min_override);
            total_created += res.created || 0;
        }
    }
    return { created: total_created, tenants: tenant_rows.length };
};

export const start_reflection = () => {
    if (!env.auto_reflect || timer) return;
    const int = (env.reflect_interval || 10) * 60000;
    timer = setInterval(
        () => run_reflection_all_tenants().catch((e) => console.error("[REFLECT]", e)),
        int,
    );
    console.error(`[REFLECT] Started: every ${env.reflect_interval || 10}m`);
};

export const stop_reflection = () => {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
};
