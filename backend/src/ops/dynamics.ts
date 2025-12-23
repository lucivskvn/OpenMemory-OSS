import { all_async, run_async, get_async, q, TABLE_MEMORIES, TABLE_WAYPOINTS, vector_store } from "../core/db";
import { now, parse_int, parse_bool, clamp_f, clamp_i } from "../utils";
import { cosineSimilarity, bufferToVector } from "../memory/embed";
import { log } from "../core/log";
import { env } from "../core/cfg";

// Constants for Learning and Decay
export const ALPHA_LEARNING_RATE_FOR_RECALL_REINFORCEMENT = 0.15;
export const BETA_LEARNING_RATE_FOR_EMOTIONAL_FREQUENCY = 0.2;
export const GAMMA_ATTENUATION_CONSTANT_FOR_GRAPH_DISTANCE = 0.35;
export const THETA_CONSOLIDATION_COEFFICIENT_FOR_LONG_TERM = 0.4;
export const ETA_REINFORCEMENT_FACTOR_FOR_TRACE_LEARNING = 0.18;
export const LAMBDA_ONE_FAST_DECAY_RATE = 0.015;
export const LAMBDA_TWO_SLOW_DECAY_RATE = 0.002;
export const TAU_ENERGY_THRESHOLD_FOR_RETRIEVAL = 0.4;

// Compression configuration
const COMPRESSION_CFG = {
    min_vec_dim: parse_int(process.env.OM_MIN_VECTOR_DIM, 64),
    max_vec_dim: parse_int(process.env.OM_MAX_VECTOR_DIM, env.vec_dim || 1536),
    summary_layers: clamp_i(parse_int(process.env.OM_SUMMARY_LAYERS, 3), 1, 3),
    cold_threshold: 0.3,
    compress_threshold: 0.7,
    regeneration_enabled: parse_bool(process.env.OM_REGENERATION_ENABLED, true),
    reinforce_on_query: parse_bool(process.env.OM_DECAY_REINFORCE_ON_QUERY, true),
};

let active_q = 0;
export const inc_q = () => active_q++;
export const dec_q = () => active_q--;

export const SECTORAL_INTERDEPENDENCE_MATRIX_FOR_COGNITIVE_RESONANCE = [
    [1.0, 0.7, 0.3, 0.6, 0.6],
    [0.7, 1.0, 0.4, 0.7, 0.8],
    [0.3, 0.4, 1.0, 0.5, 0.2],
    [0.6, 0.7, 0.5, 1.0, 0.8],
    [0.6, 0.8, 0.2, 0.8, 1.0],
];

export const SECTOR_INDEX_MAPPING_FOR_MATRIX_LOOKUP: Record<string, number> = {
    episodic: 0,
    semantic: 1,
    procedural: 2,
    emotional: 3,
    reflective: 4,
};

export interface DynamicSalienceWeightingParameters {
    initial_salience_value: number;
    decay_constant_lambda: number;
    recall_reinforcement_count: number;
    emotional_frequency_metric: number;
}

const sig = (x: number) => 1 / (1 + Math.exp(-x));
export const linkW = (sem: number, emo: number, α = 0.7, β = 0.3) =>
    sig(α * sem + β * emo);

export function calculateDynamicSalienceWithTimeDecay(
    i: number,
    λ: number,
    r: number,
    e: number,
    t: number,
): number {
    const d = i * Math.exp(-λ * t);
    const rc = ALPHA_LEARNING_RATE_FOR_RECALL_REINFORCEMENT * r;
    const ef = BETA_LEARNING_RATE_FOR_EMOTIONAL_FREQUENCY * e;
    return Math.max(0, Math.min(1, d + rc + ef));
}

export function calculateDualPhaseDecayMemoryRetention(
    t: number,
): number {
    const f = Math.exp(-LAMBDA_ONE_FAST_DECAY_RATE * t);
    const s =
        THETA_CONSOLIDATION_COEFFICIENT_FOR_LONG_TERM *
        Math.exp(-LAMBDA_TWO_SLOW_DECAY_RATE * t);
    return Math.max(0, Math.min(1, f + s));
}

export function calculateAssociativeWaypointLinkWeight(
    sv: number[],
    tv: number[],
    tg: number,
): number {
    const sim = cosineSimilarity(sv, tv);
    const td = tg / 86400000;
    return Math.max(0, sim / (1 + td));
}

export function applyRetrievalTraceReinforcementToMemory(
    mid: string,
    sal: number,
): number {
    return Math.min(
        1,
        sal + ETA_REINFORCEMENT_FACTOR_FOR_TRACE_LEARNING * (1 - sal),
    );
}

export async function propagateAssociativeReinforcementToLinkedNodes(
    sid: string,
    ssal: number,
    wps: Array<{ target_id: string; weight: number }>,
): Promise<Array<{ node_id: string; new_salience: number }>> {
    const ups: Array<{ node_id: string; new_salience: number }> = [];
    for (const wp of wps) {
        const ld = (await get_async(
            `select salience from ${TABLE_MEMORIES} where id=?`,
            [wp.target_id],
        )) as any;
        if (ld) {
            const pr =
                ETA_REINFORCEMENT_FACTOR_FOR_TRACE_LEARNING * wp.weight * ssal;
            ups.push({
                node_id: wp.target_id,
                new_salience: Math.min(1, ld.salience + pr),
            });
        }
    }
    return ups;
}

export function calculateCrossSectorResonanceScore(
    ms: string,
    qs: string,
    bs: number,
): number {
    const si = SECTOR_INDEX_MAPPING_FOR_MATRIX_LOOKUP[ms] ?? 1;
    const ti = SECTOR_INDEX_MAPPING_FOR_MATRIX_LOOKUP[qs] ?? 1;
    return bs * SECTORAL_INTERDEPENDENCE_MATRIX_FOR_COGNITIVE_RESONANCE[si][ti];
}

export function determineEnergyBasedRetrievalThreshold(
    act: number,
    tau: number,
): number {
    const nrm = Math.max(0.1, act);
    return Math.max(0.1, Math.min(0.9, tau * (1 + Math.log(nrm + 1))));
}

/**
 * Applies time-based decay to all memories.
 * Optimized to process in chunks to avoid locking the database or exhausting memory.
 */
// --- Compression Logic ---

const mean = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const l2 = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const normalize = (v: number[]) => {
    const n = l2(v) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
};

const compress_vector = (vec: number[], f: number, min_dim = 64, max_dim = 1536): number[] => {
    const src = vec.length ? vec : [1];
    const tgt_dim = Math.max(min_dim, Math.min(max_dim, Math.floor(src.length * clamp_f(f, 0.0, 1.0))));
    const dim = Math.max(min_dim, Math.min(src.length, tgt_dim));
    if (dim >= src.length) return src.slice(0);

    const pooled: number[] = [];
    const bucket = Math.ceil(src.length / dim);
    for (let i = 0; i < src.length; i += bucket)
        pooled.push(mean(src.slice(i, i + bucket)));

    normalize(pooled);
    return pooled;
};

const stop_words = new Set(["the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "with", "at", "by", "is", "it", "be", "as", "are", "was", "were", "from", "that", "this", "these", "those", "but", "if", "then", "so", "than", "into", "over", "under", "about", "via", "vs", "not"]);

const top_keywords = (t: string, k = 5): string[] => {
    const words = (t.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => !stop_words.has(w));
    if (!words.length) return [];
    const freq = new Map<string, number>();
    for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
    return Array.from(freq.entries())
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, k)
        .map(([w]) => w);
};

const summarize_quick = (t: string): string => {
    const sents = t.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (!sents.length) return t;
    const score = (s: string) => top_keywords(s, 6).length + Math.min(3, s.match(/[,;:]/g)?.length || 0);
    const top = sents
        .map((s, i) => ({ s, i, sc: score(s) }))
        .sort((a, b) => b.sc - a.sc || a.i - b.i)
        .slice(0, Math.min(3, Math.ceil(sents.length / 3)))
        .sort((a, b) => a.i - b.i)
        .map(x => x.s)
        .join(" ");
    return top || sents[0];
};

const compress_summary = (txt: string, f: number, layers = 3): string => {
    const t = (txt || "").trim();
    if (!t) return "";
    const lay = clamp_i(layers, 1, 3);
    const trunc = (s: string, n: number) => s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";

    if (f > 0.8) return trunc(t, 200);
    if (f > 0.4) return trunc(summarize_quick(t), lay >= 2 ? 80 : 200);
    return top_keywords(t, lay >= 3 ? 5 : 3).join(" ");
};

const hash_to_vec = (s: string, d = 32): number[] => {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    const out: number[] = new Array(Math.max(2, d | 0)).fill(0);
    let x = h || 1;
    for (let i = 0; i < out.length; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        out[i] = ((x >>> 0) / 0xffffffff) * 2 - 1;
    }
    normalize(out);
    return out;
};

const fingerprint_mem = (m: any): { vector: number[]; summary: string } => {
    const base = (m.id + "|" + (m.summary || m.content || "")).trim();
    const vec = hash_to_vec(base, 32);
    const summary = top_keywords(m.summary || m.content || "", 3).join(" ");
    return { vector: vec, summary };
};

/**
 * Applies time-based decay to all memories.
 * Optimized to process in chunks to avoid locking the database or exhausting memory.
 */
export async function applyDualPhaseDecayToAllMemories(): Promise<{ processed: number; decayed: number }> {
    if (active_q > 0) {
        log.info(`[DECAY] Skipped - ${active_q} active queries`);
        return { processed: 0, decayed: 0 };
    }

    const limit = 1000;
    let offset = 0;
    const ts = now();
    let total_processed = 0;
    let total_decayed = 0;
    let total_compressed = 0;
    let total_fingerprinted = 0;

    log.info("[DECAY] Starting dual-phase decay process...");

    while (true) {
        const mems = await all_async(
            `select id,salience,decay_lambda,last_seen_at,updated_at,created_at,content,summary,primary_sector from ${TABLE_MEMORIES} limit ? offset ?`,
            [limit, offset]
        );

        if (mems.length === 0) break;

        let batch_updates = 0;

        const ops = mems.map(async (m: any) => {
            const tms = Math.max(0, ts - (m.last_seen_at || m.updated_at));
            const td = tms / 86400000;
            const rt = calculateDualPhaseDecayMemoryRetention(td); // retention factor (0.0 - 1.0)
            const nsal = m.salience * rt;
            let changed = Math.abs(nsal - m.salience) > 0.001;

            // Lifecycle Management: Compression & Fingerprinting
            const f = rt; // use retention as freshness factor

            // 1. Compression (Warm -> Cold transition)
            if (f < COMPRESSION_CFG.compress_threshold) {
                const sector = m.primary_sector || "semantic";
                // Only load vector if we might compress
                const vec_row = await vector_store.getVector(m.id, sector);

                if (vec_row && vec_row.vector) {
                    const vec = typeof vec_row.vector === "string" ? JSON.parse(vec_row.vector) : vec_row.vector;
                    if (Array.isArray(vec) && vec.length > COMPRESSION_CFG.min_vec_dim) {
                        const new_vec = compress_vector(vec, f, COMPRESSION_CFG.min_vec_dim, COMPRESSION_CFG.max_vec_dim);
                        const new_summary = compress_summary(m.summary || m.content || "", f, COMPRESSION_CFG.summary_layers);

                        // Only update if actually smaller/changed
                        if (new_vec.length < vec.length) {
                            await vector_store.storeVector(m.id, sector, new_vec, new_vec.length);
                            changed = true;
                            total_compressed++;
                        }
                        if (new_summary !== (m.summary || "")) {
                            await run_async(`update ${TABLE_MEMORIES} set summary=? where id=?`, [new_summary, m.id]);
                            changed = true;
                        }
                    }
                }
            }

            // 2. Fingerprinting (Deep Cold)
            if (f < COMPRESSION_CFG.cold_threshold) {
                const sector = m.primary_sector || "semantic";
                const fp = fingerprint_mem(m);
                await vector_store.storeVector(m.id, sector, fp.vector, fp.vector.length);
                await run_async(`update ${TABLE_MEMORIES} set summary=? where id=?`, [fp.summary, m.id]);
                changed = true;
                total_fingerprinted++;
            }

            if (changed) {
                await run_async(
                    `update ${TABLE_MEMORIES} set salience=?,updated_at=? where id=?`,
                    [Math.max(0, nsal), ts, m.id],
                );
                batch_updates++;
            }
        });

        await Promise.all(ops);
        total_processed += mems.length;
        total_decayed += batch_updates;
        offset += limit;

        if (offset % 5000 === 0) await new Promise(resolve => setTimeout(resolve, 10));
    }

    log.info(`[DECAY] Processed ${total_processed} | Updated ${total_decayed} | Compressed ${total_compressed} | Fingerprinted ${total_fingerprinted}`);
    return { processed: total_processed, decayed: total_decayed };
}

export const on_query_hit = async (
    mem_id: string,
    sector: string,
    reembed?: (text: string) => Promise<number[]>,
) => {
    if (!COMPRESSION_CFG.regeneration_enabled && !COMPRESSION_CFG.reinforce_on_query) return;

    const m = await q.get_mem.get(mem_id);
    if (!m) return;

    let updated = false;

    if (COMPRESSION_CFG.regeneration_enabled && reembed) {
        const vec_row = await vector_store.getVector(mem_id, sector);
        if (vec_row && vec_row.vector) {
            const vec = typeof vec_row.vector === "string" ? JSON.parse(vec_row.vector) : vec_row.vector;
            // If vector is compressed (low dim), regenerate it
            if (Array.isArray(vec) && vec.length <= 64) {
                try {
                    const base = m.summary || m.content || "";
                    const new_vec = await reembed(base);
                    await vector_store.storeVector(
                        mem_id,
                        sector,
                        new_vec,
                        new_vec.length,
                    );
                    updated = true;
                } catch (e) {
                    log.warn(`[DECAY] Regeneration failed for ${mem_id}`, {error: e});
                }
            }
        }
    }

    if (COMPRESSION_CFG.reinforce_on_query) {
        const new_sal = clamp_f((m.salience || 0.5) + 0.5, 0, 1);
        await run_async(
            `update ${TABLE_MEMORIES} set salience=?,last_seen_at=? where id=?`,
            [new_sal, now(), mem_id],
        );
        updated = true;
    }

    if (updated) {
        log.info(`[DECAY] Regenerated/Reinforced memory ${mem_id}`);
    }
};

/**
 * Performs Spreading Activation on the waypoint graph.
 * Fetches edges incrementally from the database.
 */
export async function performSpreadingActivationRetrieval(
    init: string[],
    max: number,
): Promise<Map<string, number>> {
    const act = new Map<string, number>();
    for (const id of init) act.set(id, 1.0);

    for (let i = 0; i < max; i++) {
        const sources = Array.from(act.keys());
        if (sources.length === 0) break;

        const placeholders = sources.map(() => '?').join(',');
        const edges = await all_async(
            `select src_id, dst_id, weight from ${TABLE_WAYPOINTS} where src_id in (${placeholders})`,
            sources
        );

        if (edges.length === 0) break;

        const ups = new Map<string, number>();

        for (const e of edges) {
            const ca = act.get(e.src_id) || 0;
            const att = Math.exp(-GAMMA_ATTENUATION_CONSTANT_FOR_GRAPH_DISTANCE);
            const energy = e.weight * ca * att;

            const current_dst_energy = ups.get(e.dst_id) || 0;
            ups.set(e.dst_id, current_dst_energy + energy);
        }

        for (const [uid, nav] of ups) {
            const cv = act.get(uid) || 0;
            act.set(uid, Math.max(cv, nav));
        }
    }
    return act;
}

/**
 * Retrieves memories based on vector similarity + sector resonance + spreading activation.
 * Optimized to use vector index for initial candidates.
 */
export async function retrieveMemoriesWithEnergyThresholding(
    qv: number[],
    qs: string,
    me: number,
): Promise<any[]> {
    // 1. Fetch Candidates via Vector Search (Index-based)
    // Get top 100 to allow re-ranking
    const vector_matches = await vector_store.search(qv, 100);

    if (vector_matches.length === 0) return [];

    const ids = vector_matches.map(m => m.id);
    const placeholders = ids.map(() => '?').join(',');

    // Fetch metadata for candidates to calculate full score
    const rows = await all_async(
        `select id,primary_sector,salience from ${TABLE_MEMORIES} where id in (${placeholders})`,
        ids
    );

    const rowMap = new Map(rows.map((r: any) => [r.id, r]));
    const sc = new Map<string, number>();
    const candidates = [];

    // 2. Score Candidates
    for (const match of vector_matches) {
        const m = rowMap.get(match.id);
        if (!m) continue;
        if (m.salience <= 0.01) continue; // Filter dead memories

        // match.score is cosine similarity (0-1)
        const bs = match.score;
        const cs = calculateCrossSectorResonanceScore(
            m.primary_sector,
            qs,
            bs,
        );
        // Salience modulates the score
        const score = cs * m.salience;
        sc.set(m.id, score);
        candidates.push({ id: m.id, score });
    }

    // Sort and pick top K for spreading activation seeds
    candidates.sort((a, b) => b.score - a.score);
    const topK = candidates.slice(0, 5).map(c => c.id);

    // 3. Spreading Activation
    const sp = await performSpreadingActivationRetrieval(topK, 3);

    // 4. Combine Scores
    const combined_scores = new Map<string, number>();
    for (const c of candidates) {
        const base = c.score;
        const activation = sp.get(c.id) || 0;
        combined_scores.set(c.id, base + activation * 0.3);
    }

    // 5. Thresholding
    const total_energy = Array.from(combined_scores.values()).reduce((s, v) => s + v, 0);
    const thr = determineEnergyBasedRetrievalThreshold(total_energy, me);

    const final_ids = candidates
        .filter(c => (combined_scores.get(c.id) || 0) > thr)
        .map(c => c.id);

    if (final_ids.length === 0) return [];

    // 6. Fetch Content (Batch)
    const final_mems = await q.get_mems_by_ids.all(final_ids);

    // Attach activation energy to result
    return final_mems.map((m: any) => ({
        ...m,
        activation_energy: combined_scores.get(m.id)
    }));
}

export const apply_decay = applyDualPhaseDecayToAllMemories;
