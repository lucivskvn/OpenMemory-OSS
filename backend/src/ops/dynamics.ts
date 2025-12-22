import { all_async, run_async, get_async, q, TABLE_MEMORIES, TABLE_WAYPOINTS } from "../core/db";
import { now } from "../utils";
import { cosineSimilarity, bufferToVector } from "../memory/embed";
import { log } from "../core/log";

// Constants for Learning and Decay
export const ALPHA_LEARNING_RATE_FOR_RECALL_REINFORCEMENT = 0.15;
export const BETA_LEARNING_RATE_FOR_EMOTIONAL_FREQUENCY = 0.2;
export const GAMMA_ATTENUATION_CONSTANT_FOR_GRAPH_DISTANCE = 0.35;
export const THETA_CONSOLIDATION_COEFFICIENT_FOR_LONG_TERM = 0.4;
export const ETA_REINFORCEMENT_FACTOR_FOR_TRACE_LEARNING = 0.18;
export const LAMBDA_ONE_FAST_DECAY_RATE = 0.015;
export const LAMBDA_TWO_SLOW_DECAY_RATE = 0.002;
export const TAU_ENERGY_THRESHOLD_FOR_RETRIEVAL = 0.4;

export const SECTORAL_INTERDEPENDENCE_MATRIX_FOR_COGNITIVE_RESONANCE = [
    [1.0, 0.7, 0.3, 0.6, 0.6],
    [0.7, 1.0, 0.4, 0.7, 0.8],
    [0.3, 0.4, 1.0, 0.5, 0.2],
    [0.6, 0.7, 0.5, 1.0, 0.8],
    [0.6, 0.8, 0.2, 0.8, 1.0],
];

export const SECTOR_INDEX_MAPPING_FOR_MATRIX_LOOKUP = {
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

export async function calculateDynamicSalienceWithTimeDecay(
    i: number,
    λ: number,
    r: number,
    e: number,
    t: number,
): Promise<number> {
    const d = i * Math.exp(-λ * t);
    const rc = ALPHA_LEARNING_RATE_FOR_RECALL_REINFORCEMENT * r;
    const ef = BETA_LEARNING_RATE_FOR_EMOTIONAL_FREQUENCY * e;
    return Math.max(0, Math.min(1, d + rc + ef));
}

export async function calculateDualPhaseDecayMemoryRetention(
    t: number,
): Promise<number> {
    const f = Math.exp(-LAMBDA_ONE_FAST_DECAY_RATE * t);
    const s =
        THETA_CONSOLIDATION_COEFFICIENT_FOR_LONG_TERM *
        Math.exp(-LAMBDA_TWO_SLOW_DECAY_RATE * t);
    return Math.max(0, Math.min(1, f + s));
}

export async function calculateAssociativeWaypointLinkWeight(
    sv: number[],
    tv: number[],
    tg: number,
): Promise<number> {
    const sim = cosineSimilarity(sv, tv);
    const td = tg / 86400000;
    return Math.max(0, sim / (1 + td));
}

export async function applyRetrievalTraceReinforcementToMemory(
    mid: string,
    sal: number,
): Promise<number> {
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

export async function calculateCrossSectorResonanceScore(
    ms: string,
    qs: string,
    bs: number,
): Promise<number> {
    const si = (SECTOR_INDEX_MAPPING_FOR_MATRIX_LOOKUP as any)[ms] ?? 1;
    const ti = (SECTOR_INDEX_MAPPING_FOR_MATRIX_LOOKUP as any)[qs] ?? 1;
    return bs * SECTORAL_INTERDEPENDENCE_MATRIX_FOR_COGNITIVE_RESONANCE[si][ti];
}

export async function determineEnergyBasedRetrievalThreshold(
    act: number,
    tau: number,
): Promise<number> {
    const nrm = Math.max(0.1, act);
    return Math.max(0.1, Math.min(0.9, tau * (1 + Math.log(nrm + 1))));
}

/**
 * Applies time-based decay to all memories.
 * Optimized to process in chunks to avoid locking the database or exhausting memory.
 */
export async function applyDualPhaseDecayToAllMemories(): Promise<{ processed: number; decayed: number }> {
    const limit = 1000;
    let offset = 0;
    const ts = now();
    let total_processed = 0;
    let total_decayed = 0;

    log.info("[DECAY] Starting dual-phase decay process...");

    while (true) {
        // Fetch only necessary columns
        const mems = await all_async(
            `select id,salience,decay_lambda,last_seen_at,updated_at,created_at from ${TABLE_MEMORIES} limit ? offset ?`,
            [limit, offset]
        );

        if (mems.length === 0) break;

        // Use a temp counter for this batch to ensure safety if needed, but local var capture is safe in JS event loop
        let batch_decayed = 0;

        const ops = mems.map(async (m: any) => {
            const tms = Math.max(0, ts - (m.last_seen_at || m.updated_at));
            const td = tms / 86400000;
            const rt = await calculateDualPhaseDecayMemoryRetention(td);
            const nsal = m.salience * rt;

            // Only update if change is significant (> 0.001)
            if (Math.abs(nsal - m.salience) > 0.001) {
                await run_async(
                    `update ${TABLE_MEMORIES} set salience=?,updated_at=? where id=?`,
                    [Math.max(0, nsal), ts, m.id],
                );
                batch_decayed++;
            }
        });

        await Promise.all(ops);
        total_processed += mems.length;
        total_decayed += batch_decayed;
        offset += limit;

        // Yield to event loop
        if (offset % 5000 === 0) await new Promise(resolve => setTimeout(resolve, 10));
    }
    log.info(`[DECAY] Processed ${total_processed} memories, updated ${total_decayed}`);
    return { processed: total_processed, decayed: total_decayed };
}

/**
 * Performs Spreading Activation on the waypoint graph.
 * Fetches edges incrementally from the database instead of loading the entire graph.
 */
export async function performSpreadingActivationRetrieval(
    init: string[],
    max: number,
): Promise<Map<string, number>> {
    const act = new Map<string, number>();
    for (const id of init) act.set(id, 1.0);

    // Iterate for 'max' steps (hops)
    for (let i = 0; i < max; i++) {
        const sources = Array.from(act.keys());
        if (sources.length === 0) break;

        // Fetch outgoing edges for all currently active nodes
        // Use IN clause for batching
        const placeholders = sources.map(() => '?').join(',');
        const edges = await all_async(
            `select src_id, dst_id, weight from ${TABLE_WAYPOINTS} where src_id in (${placeholders})`,
            sources
        );

        if (edges.length === 0) break;

        const ups = new Map<string, number>();

        // Process edges
        for (const e of edges) {
            const ca = act.get(e.src_id) || 0;
            // Attenuation based on hop distance (simplified to 1 per hop here)
            const att = Math.exp(-GAMMA_ATTENUATION_CONSTANT_FOR_GRAPH_DISTANCE);
            const energy = e.weight * ca * att;

            const current_dst_energy = ups.get(e.dst_id) || 0;
            ups.set(e.dst_id, current_dst_energy + energy);
        }

        // Update activations: Keep max of current or new energy
        for (const [uid, nav] of ups) {
            const cv = act.get(uid) || 0;
            act.set(uid, Math.max(cv, nav));
        }
    }
    return act;
}

/**
 * Retrieves memories based on vector similarity + sector resonance + spreading activation.
 * Optimized to fetch vectors first, score, and then fetch content for top candidates.
 */
export async function retrieveMemoriesWithEnergyThresholding(
    qv: number[],
    qs: string,
    me: number,
): Promise<any[]> {
    // 1. Fetch Candidates (Vector + Metadata only)
    // Filter by salience to avoid dead memories
    const rows = (await all_async(
        `select id,primary_sector,salience,mean_vec from ${TABLE_MEMORIES} where salience > 0.01`,
    )) as any[];

    const sc = new Map<string, number>();

    // 2. Score Candidates (CPU bound, but efficient with Float32Array)
    const candidates = [];
    for (const m of rows) {
        if (!m.mean_vec) continue;
        const vec = bufferToVector(m.mean_vec);
        const bs = cosineSimilarity(qv, vec);
        const cs = await calculateCrossSectorResonanceScore(
            m.primary_sector,
            qs,
            bs,
        );
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
    const thr = await determineEnergyBasedRetrievalThreshold(total_energy, me);

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
