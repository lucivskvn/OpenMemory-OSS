import { q, log_maint_op } from "../core/db";
import { add_hsg_memory } from "./hsg";
import { env } from "../core/cfg";
import { j } from "../utils";
import logger from "../core/logger";
// Test seam to capture reflection logs deterministically in tests
export const __TEST: {
    logHook?: ((level: string, meta: any, msg: string, ...args: any[]) => void) | null;
    reset?: () => void;
} = {
    logHook: null,
    reset() {
        this.logHook = null;
    },
};

function reflectLog(level: 'debug' | 'info' | 'warn' | 'error', meta: any, msg: string, ...args: any[]) {
    try {
        try {
            const hook = (__TEST as any)?.logHook;
            if (typeof hook === 'function') {
                try { hook(level, meta, msg, ...args); } catch (_) { }
            }
        } catch (_) { }
        const fn = (logger as any)[level] || logger.info;
        fn.call(logger, meta, msg, ...args);
    } catch (e) {
        try { console.error('[REFLECT] logging failure', e); } catch (_err) { }
    }
}

const cos = (a: number[], b: number[]): number => {
    let d = 0,
        ma = 0,
        mb = 0;
    for (let i = 0; i < a.length; i++) {
        d += a[i] * b[i];
        ma += a[i] * a[i];
        mb += b[i] * b[i];
    }
    return d / (Math.sqrt(ma) * Math.sqrt(mb));
};

const vec = (txt: string): number[] => {
    const w = txt.toLowerCase().split(/\s+/);
    const uniq = [...new Set(w)];
    return uniq.map((u) => w.filter((x) => x === u).length);
};

const sim = (t1: string, t2: string): number => cos(vec(t1), vec(t2));

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

const mark = async (ids: string[]) => {
    for (const id of ids) {
        const m = await q.get_mem.get(id, null);
        if (m) {
            const meta = JSON.parse(m.meta || "{}");
            meta.consolidated = true;
            await q.upd_mem.run(
                m.content,
                m.tags,
                JSON.stringify(meta),
                Date.now(),
                id,
            );
        }
    }
};

const boost = async (ids: string[]) => {
    for (const id of ids) {
        const m = await q.get_mem.get(id, null);
        if (m) await q.upd_mem.run(m.content, m.tags, m.meta, Date.now(), id);
        await q.upd_seen.run(
            id,
            m.last_seen_at,
            Math.min(1, m.salience * 1.1),
            Date.now(),
        );
    }
};

export const run_reflection = async () => {
    reflectLog('info', { component: "REFLECT" }, "[REFLECT] Starting reflection job...");
    const min = env.reflect_min || 20;
    let mems = [] as any[];
    try {
        mems = await q.all_mem.all(100, 0);
    } catch (e) {
        // In strict tenant mode (`OM_STRICT_TENANT=true`) some helper calls
        // like `all_mem` require an explicit `user_id`. For background
        // maintenance tasks (reflect/decay etc.) we fall back to segment
        // enumeration which is not tenant-scoped and remains safe for
        // internal maintenance. This preserves tenant enforcement while
        // allowing background jobs to run in CI/tests.
        try {
            const segs = await q.get_segments.all();
            for (const s of segs) {
                const segN = s.segment ?? s.max_seg ?? s;
                const rows = await q.get_mem_by_segment.all(segN);
                mems.push(...rows);
            }
            // Limit to first 100 entries for parity with the usual call
            mems = mems.slice(0, 100);
        } catch (se) {
            // Unexpected fallback failure: surface original error
            throw e;
        }
    }
    reflectLog('info', { component: "REFLECT", fetched: mems.length, min_required: min }, "[REFLECT] Fetched %d memories (min required: %d)", mems.length, min);
    if (mems.length < min) {
        logger.info({ component: "REFLECT" }, "[REFLECT] Not enough memories, skipping");
        return { created: 0, reason: "low" };
    }
    const cls = cluster(mems);
    reflectLog('info', { component: "REFLECT", clusters: cls.length }, "[REFLECT] Clustered into %d groups", cls.length);
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
        reflectLog('info', { component: "REFLECT", freq: c.n, salience: s, sector: c.mem[0].primary_sector }, "[REFLECT] Creating reflection: %d memories, salience=%s, sector=%s", c.n, s.toFixed(3), c.mem[0].primary_sector);
        // If all source memories belong to the same user, attach the reflection to that user.
        const userIds = new Set<string>(
            c.mem
                .map((m: any) => m.user_id)
                .filter((u: any): u is string => !!u && typeof u === "string"),
        );
        const reflectionUser: string | undefined = userIds.size === 1 ? Array.from(userIds)[0] : undefined;
        await add_hsg_memory(txt, j(["reflect:auto"]), meta, reflectionUser);
        await mark(src);
        await boost(src);
        n++;
    }
    if (n > 0) await log_maint_op("reflect", n);
    reflectLog('info', { component: "REFLECT", created: n }, "[REFLECT] Job complete: created %d reflections", n);
    return { created: n, clusters: cls.length };
};

let timer: NodeJS.Timeout | null = null;

export const start_reflection = () => {
    if (!env.auto_reflect || timer) return;
    const int = (env.reflect_interval || 10) * 60000;
    timer = setInterval(
        () => run_reflection().catch((e) => reflectLog('error', { component: "REFLECT", err: e }, "[REFLECT] %o", e)),
        int,
    );
    reflectLog('info', { component: "REFLECT", interval_minutes: env.reflect_interval || 10 }, "[REFLECT] Started: every %d m", env.reflect_interval || 10);
};

export const stop_reflection = () => {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
};
