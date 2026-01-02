
import { canonical_token_set } from "../utils/text";
import { inc_q, dec_q, on_query_hit } from "./decay";
import { env, tier } from "../core/cfg";
import { LearnedClassifier, ClassifierModel } from "../core/learned_classifier";
import { get_encryption } from "../core/security";

import {
    SectorConfig,
    SectorClassification,
    HsgQueryResult,
    MultiVecFusionWeights,
    Waypoint,
    MemoryRow,
    SectorType
} from "../core/types";

export const sector_configs: Record<SectorType | string, SectorConfig> = {
    episodic: {
        model: "episodic-optimized",
        decay_lambda: 0.015,
        weight: 1.2,
        patterns: [
            /\b(today|yesterday|tomorrow|last\s+(week|month|year)|next\s+(week|month|year))\b/i,
            /\b(remember\s+when|recall|that\s+time|when\s+I|I\s+was|we\s+were)\b/i,
            /\b(went|saw|met|felt|heard|visited|attended|participated)\b/i,
            /\b(at\s+\d{1,2}:\d{2}|on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i,
            /\b(event|moment|experience|incident|occurrence|happened)\b/i,
            /\bI\s+'?m\s+going\s+to\b/i,
        ],
    },
    semantic: {
        model: "semantic-optimized",
        decay_lambda: 0.005,
        weight: 1.0,
        patterns: [
            /\b(is\s+a|represents|means|stands\s+for|defined\s+as)\b/i,
            /\b(concept|theory|principle|law|hypothesis|theorem|axiom)\b/i,
            /\b(fact|statistic|data|evidence|proof|research|study|report)\b/i,
            /\b(capital|population|distance|weight|height|width|depth)\b/i,
            /\b(history|science|geography|math|physics|biology|chemistry)\b/i,
            /\b(know|understand|learn|read|write|speak)\b/i,
        ],
    },
    procedural: {
        model: "procedural-optimized",
        decay_lambda: 0.008,
        weight: 1.1,
        patterns: [
            /\b(how\s+to|step\s+by\s+step|guide|tutorial|manual|instructions)\b/i,
            /\b(first|second|then|next|finally|afterwards|lastly)\b/i,
            /\b(install|run|execute|compile|build|deploy|configure|setup)\b/i,
            /\b(click|press|type|enter|select|drag|drop|scroll)\b/i,
            /\b(method|function|class|algorithm|routine|recipe)\b/i,
            /\b(to\s+do|to\s+make|to\s+build|to\s+create)\b/i,
        ],
    },
    emotional: {
        model: "emotional-optimized",
        decay_lambda: 0.02,
        weight: 1.3,
        patterns: [
            /\b(feel|feeling|felt|emotions?|mood|vibe)\b/i,
            /\b(happy|sad|angry|mad|excited|scared|anxious|nervous|depressed)\b/i,
            /\b(love|hate|like|dislike|adore|detest|enjoy|loathe)\b/i,
            /\b(amazing|terrible|awesome|awful|wonderful|horrible|great|bad)\b/i,
            /\b(frustrated|confused|overwhelmed|stressed|relaxed|calm)\b/i,
            /\b(wow|omg|yay|nooo|ugh|sigh)\b/i,
            /[!]{2,}/,
        ],
    },
    reflective: {
        model: "reflective-optimized",
        decay_lambda: 0.001,
        weight: 0.8,
        patterns: [
            /\b(realize|realized|realization|insight|epiphany)\b/i,
            /\b(think|thought|thinking|ponder|contemplate|reflect)\b/i,
            /\b(understand|understood|understanding|grasp|comprehend)\b/i,
            /\b(pattern|trend|connection|link|relationship|correlation)\b/i,
            /\b(lesson|moral|takeaway|conclusion|summary|implication)\b/i,
            /\b(feedback|review|analysis|evaluation|assessment)\b/i,
            /\b(improve|grow|change|adapt|evolve)\b/i,
        ],
    },
};
export const sectors = Object.keys(sector_configs);
export const scoring_weights = {
    similarity: 0.35,
    overlap: 0.20,
    waypoint: 0.15,
    recency: 0.10,
    tag_match: 0.20,
};
export const hybrid_params = {
    tau: 3,
    beta: 2,
    eta: 0.1,
    gamma: 0.2,
    alpha_reinforce: 0.08,
    t_days: 7,
    t_max_days: 60,
    tau_hours: 1,
    epsilon: 1e-8,
};
export const reinforcement = {
    salience_boost: 0.1,
    waypoint_boost: 0.05,
    max_salience: 1.0,
    max_waypoint_weight: 1.0,
    prune_threshold: 0.05,
};

// Sector relationship matrix for cross-sector retrieval
// Higher values = stronger relationship = less penalty
export const sector_relationships: Record<string, Record<string, number>> = {
    semantic: { procedural: 0.8, episodic: 0.6, reflective: 0.7, emotional: 0.4 },
    procedural: { semantic: 0.8, episodic: 0.6, reflective: 0.6, emotional: 0.3 },
    episodic: { reflective: 0.8, semantic: 0.6, procedural: 0.6, emotional: 0.7 },
    reflective: { episodic: 0.8, semantic: 0.7, procedural: 0.6, emotional: 0.6 },
    emotional: { episodic: 0.7, reflective: 0.6, semantic: 0.4, procedural: 0.3 },
};

// Detect temporal markers in query for full-sector search
function has_temporal_markers(text: string): boolean {
    const temporal_patterns = [
        /\b(today|yesterday|tomorrow|this\s+week|last\s+week|this\s+morning)\b/i,
        /\b\d{4}-\d{2}-\d{2}\b/,  // ISO date format like 2025-11-20
        /\b20\d{2}[/-]?(0[1-9]|1[0-2])[/-]?(0[1-9]|[12]\d|3[01])\b/, // Date patterns
        /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/i,
        /\bwhat\s+(did|have)\s+(i|we)\s+(do|done)\b/i,  // "what did I do" patterns
    ];
    return temporal_patterns.some(p => p.test(text));
}

// Calculate tag match score between query tokens and memory tags
async function compute_tag_match_score(memory_id: string, query_tokens: Set<string>, user_id?: string): Promise<number> {
    const mem = await q.get_mem.get(memory_id, user_id);
    if (!mem?.tags) return 0;

    try {
        let tags: any[] = [];
        if (typeof mem.tags === 'string') {
            tags = JSON.parse(mem.tags);
        } else if (Array.isArray(mem.tags)) {
            tags = mem.tags;
        }

        if (!Array.isArray(tags)) return 0;

        let matches = 0;
        for (const tag of tags) {
            const tag_lower = String(tag).toLowerCase();
            // Check exact match
            if (query_tokens.has(tag_lower)) {
                matches += 2;  // Exact match bonus
            } else {
                // Check partial match
                for (const token of query_tokens) {
                    if (tag_lower.includes(token) || token.includes(tag_lower)) {
                        matches += 1;
                    }
                }
            }
        }
        return Math.min(1.0, matches / Math.max(1, tags.length * 2));
    } catch {
        return 0;
    }
}

const compress_vec_for_storage = (
    vec: number[],
    target_dim: number,
): number[] => {
    if (vec.length <= target_dim) return vec;
    const compressed = new Float32Array(target_dim);
    const bucket_sz = vec.length / target_dim;
    for (let i = 0; i < target_dim; i++) {
        const start = Math.floor(i * bucket_sz);
        const end = Math.floor((i + 1) * bucket_sz);
        let sum = 0,
            count = 0;
        for (let j = start; j < end && j < vec.length; j++) {
            sum += vec[j];
            count++;
        }
        compressed[i] = count > 0 ? sum / count : 0;
    }
    let norm = 0;
    for (let i = 0; i < target_dim; i++) norm += compressed[i] * compressed[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < target_dim; i++) compressed[i] /= norm;
    return Array.from(compressed);
};

export function classify_content(
    content: string,
    metadata?: Record<string, unknown>,
): SectorClassification {
    if (metadata && typeof metadata.sector === "string" && sectors.includes(metadata.sector)) {
        return {
            primary: metadata.sector,
            additional: [],
            confidence: 1.0,
        };
    }
    const scores: Record<string, number> = {};
    for (const [sector, config] of Object.entries(sector_configs)) {
        let score = 0;
        for (const pattern of config.patterns) {
            const matches = content.match(pattern);
            if (matches) {
                score += matches.length * config.weight;
            }
        }
        scores[sector] = score;
    }
    const sortedScores = Object.entries(scores).sort(([, a], [, b]) => b - a);
    const primary = sortedScores[0][0];
    const primaryScore = sortedScores[0][1];
    const threshold = Math.max(1, primaryScore * 0.3);
    const additional = sortedScores
        .slice(1)
        .filter(([, score]) => score > 0 && score >= threshold)
        .map(([sector]) => sector);
    const confidence =
        primaryScore > 0
            ? Math.min(
                1.0,
                primaryScore /
                (primaryScore + (sortedScores[1]?.[1] || 0) + 1),
            )
            : 0.2;
    return {
        primary: primaryScore > 0 ? primary : "semantic",
        additional,
        confidence,
    };
}
export function calc_decay(
    sec: string,
    init_sal: number,
    days_since: number,
    seg_idx?: number,
    max_seg?: number,
): number {
    const cfg = sector_configs[sec];
    if (!cfg) return init_sal;
    let lambda = cfg.decay_lambda;
    if (seg_idx !== undefined && max_seg !== undefined && max_seg > 0) {
        const seg_ratio = Math.sqrt(seg_idx / max_seg);
        lambda = lambda * (1 - seg_ratio);
    }
    const decayed = init_sal * Math.exp(-lambda * days_since);
    const reinf =
        hybrid_params.alpha_reinforce * (1 - Math.exp(-lambda * days_since));
    return Math.max(0, Math.min(1, decayed + reinf));
}
export function calc_recency_score(last_seen: number): number {
    const now = Date.now();
    const days_since = (now - last_seen) / (1000 * 60 * 60 * 24);
    const t = hybrid_params.t_days;
    const tmax = hybrid_params.t_max_days;
    return Math.exp(-days_since / t) * (1 - days_since / tmax);
}
export function boosted_sim(s: number): number {
    return 1 - Math.exp(-hybrid_params.tau * s);
}
export function compute_simhash(text: string): string {
    const tokens = canonical_token_set(text);
    const hashes = Array.from(tokens).map((t) => {
        let h = 0;
        for (let i = 0; i < t.length; i++) {
            h = (h << 5) - h + t.charCodeAt(i);
            h = h & h;
        }
        return h;
    });
    const vec = new Array(64).fill(0);
    for (const h of hashes) {
        for (let i = 0; i < 64; i++) {
            if (h & (1 << i)) vec[i]++;
            else vec[i]--;
        }
    }
    let hash = "";
    for (let i = 0; i < 64; i += 4) {
        const nibble =
            (vec[i] > 0 ? 8 : 0) +
            (vec[i + 1] > 0 ? 4 : 0) +
            (vec[i + 2] > 0 ? 2 : 0) +
            (vec[i + 3] > 0 ? 1 : 0);
        hash += nibble.toString(16);
    }
    return hash;
}
export function hamming_dist(hash1: string, hash2: string): number {
    let dist = 0;
    for (let i = 0; i < hash1.length; i++) {
        const xor = parseInt(hash1[i], 16) ^ parseInt(hash2[i], 16);
        dist +=
            (xor & 8 ? 1 : 0) +
            (xor & 4 ? 1 : 0) +
            (xor & 2 ? 1 : 0) +
            (xor & 1 ? 1 : 0);
    }
    return dist;
}
export function sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
}
export function extract_essence(
    raw: string,
    sec: string,
    max_len: number,
): string {
    if (!env.use_summary_only || raw.length <= max_len) return raw;
    // Split on sentence boundaries (punctuation followed by whitespace) to avoid breaking filenames
    const sents = raw
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 10);
    if (sents.length === 0) return raw.slice(0, max_len);
    const score_sent = (s: string, idx: number): number => {
        let sc = 0;
        // First sentence bonus - titles/headers are essential for retrieval
        if (idx === 0) sc += 10;
        // Second sentence often contains key context
        if (idx === 1) sc += 5;
        // Header/section markers (markdown or label-style)
        if (/^#+\s/.test(s) || /^[A-Z][A-Z\s]+:/.test(s)) sc += 8;
        // Colon-prefixed labels like "PROBLEM:", "SOLUTION:", "CONTEXT:"
        if (/^[A-Z][a-z]+:/i.test(s)) sc += 6;
        // Date patterns (ISO format)
        if (/\d{4}-\d{2}-\d{2}/.test(s)) sc += 7;
        if (
            /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d+/i.test(
                s,
            )
        )
            sc += 5;
        if (/\$\d+|\d+\s*(miles|dollars|years|months|km)/.test(s)) sc += 4;
        if (/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/.test(s)) sc += 3;
        if (
            /\b(bought|purchased|serviced|visited|went|got|received|paid|earned|learned|discovered|found|saw|met|completed|finished|fixed|implemented|created|updated|added|removed|resolved)\b/i.test(
                s,
            )
        )
            sc += 4;
        if (/\b(who|what|when|where|why|how)\b/i.test(s)) sc += 2;
        if (s.length < 80) sc += 2;
        if (/\b(I|my|me)\b/.test(s)) sc += 1;
        return sc;
    };
    const scored = sents.map((s, idx) => ({ text: s, score: score_sent(s, idx), idx }));
    // Sort by score to pick the best sentences
    scored.sort((a, b) => b.score - a.score);

    // Select top sentences until we hit max_len
    const selected: typeof scored = [];
    let current_len = 0;

    // Always include the first sentence if it fits
    const firstSent = scored.find(s => s.idx === 0);
    if (firstSent && firstSent.text.length < max_len) {
        selected.push(firstSent);
        current_len += firstSent.text.length;
    }

    for (const item of scored) {
        if (item.idx === 0) continue; // Already handled
        if (current_len + item.text.length + 2 <= max_len) {
            selected.push(item);
            current_len += item.text.length + 2; // +2 for ". "
        }
    }

    // Sort selected sentences by their original index to restore context flow
    selected.sort((a, b) => a.idx - b.idx);

    return selected.map(s => s.text).join(" ");
}
export function compute_token_overlap(
    q_toks: Set<string>,
    mem_toks: Set<string>,
): number {
    if (q_toks.size === 0) return 0;
    let ov = 0;
    for (const t of q_toks) {
        if (mem_toks.has(t)) ov++;
    }
    return ov / q_toks.size;
}
export function compute_hybrid_score(
    sim: number,
    tok_ov: number,
    wp_wt: number,
    rec_sc: number,
    keyword_score: number = 0,
    tag_match: number = 0,
): number {
    const s_p = boosted_sim(sim);
    const raw =
        scoring_weights.similarity * s_p +
        scoring_weights.overlap * tok_ov +
        scoring_weights.waypoint * wp_wt +
        scoring_weights.recency * rec_sc +
        scoring_weights.tag_match * tag_match +
        keyword_score;
    return sigmoid(raw);
}
import {
    q,
    vector_store,
    get_async,
    all_async,
    run_async,
    transaction,
    log_maint_op,
} from "../core/db";
export async function create_cross_sector_waypoints(
    prim_id: string,
    prim_sec: string,
    add_secs: string[],
    user_id?: string | null,
): Promise<void> {
    const now = Date.now();
    const wt = 0.5;
    for (const sec of add_secs) {
        await q.ins_waypoint.run(
            prim_id,
            `${prim_id}:${sec}`,
            user_id ?? null,
            wt,
            now,
            now,
        );
        await q.ins_waypoint.run(
            `${prim_id}:${sec}`,
            prim_id,
            user_id ?? null,
            wt,
            now,
            now,
        );
    }
}
export function calc_mean_vec(
    emb_res: EmbeddingResult[],
    secs: string[],
): number[] {
    const dim = emb_res[0].vector.length;
    const wsum = new Array(dim).fill(0);
    const sec_scores = emb_res.map((r) => ({
        vector: r.vector,
        confidence: sector_configs[r.sector]?.weight || 1.0,
    }));
    const beta = hybrid_params.beta;
    const exp_sum = sec_scores.reduce(
        (sum, s) => sum + Math.exp(beta * s.confidence),
        0,
    );
    for (const result of emb_res) {
        const sec_wt = sector_configs[result.sector]?.weight || 1.0;
        const sm_wt = Math.exp(beta * sec_wt) / exp_sum;
        for (let i = 0; i < dim; i++) {
            wsum[i] += result.vector[i] * sm_wt;
        }
    }
    const norm =
        Math.sqrt(wsum.reduce((sum, v) => sum + v * v, 0)) +
        hybrid_params.epsilon;
    return wsum.map((v) => v / norm);
}
export async function create_single_waypoint(
    new_id: string,
    new_mean: number[],
    ts: number,
    user_id?: string | null,
): Promise<void> {
    const mems = user_id
        ? await q.all_mem_by_user.all(user_id, 1000, 0)
        : await all_async(`select * from memories where user_id IS NULL order by created_at desc limit 1000`);
    let best: { id: string; similarity: number } | null = null;
    for (const mem of mems) {
        if (mem.id === new_id || !mem.mean_vec) continue;
        const ex_mean = bufferToVector(Buffer.from(mem.mean_vec));
        const sim = cosineSimilarity(new_mean, ex_mean);
        if (!best || sim > best.similarity) {
            best = { id: mem.id, similarity: sim };
        }
    }

    if (best) {
        await q.ins_waypoint.run(
            new_id,
            best.id,
            user_id ?? null,
            best.similarity,
            ts,
            ts,
        );
    } else {
        await q.ins_waypoint.run(new_id, new_id, user_id ?? null, 1.0, ts, ts);
    }
}
export async function create_inter_mem_waypoints(
    new_id: string,
    prim_sec: string,
    new_vec: number[],
    ts: number,
    user_id?: string | null,
): Promise<void> {
    const thresh = 0.75;
    const wt = 0.5;
    const vecs = await vector_store.getVectorsBySector(prim_sec, user_id || undefined);
    for (const vr of vecs) {
        if (vr.id === new_id) continue;
        const ex_vec = vr.vector;
        const sim = cosineSimilarity(new_vec, Array.from(ex_vec));
        if (sim >= thresh) {
            await q.ins_waypoint.run(
                new_id,
                vr.id,
                user_id ?? null,
                wt,
                ts,
                ts,
            );
            await q.ins_waypoint.run(
                vr.id,
                new_id,
                user_id ?? null,
                wt,
                ts,
                ts,
            );
        }
    }
}
export async function create_contextual_waypoints(
    mem_id: string,
    rel_ids: string[],
    base_wt: number = 0.3,
    user_id?: string | null,
): Promise<void> {
    const now = Date.now();
    for (const rel_id of rel_ids) {
        if (mem_id === rel_id) continue;
        const existing = await q.get_waypoint.get(mem_id, rel_id, user_id ?? undefined);
        if (existing) {
            const new_wt = Math.min(1.0, existing.weight + 0.1);
            await q.upd_waypoint.run(mem_id, new_wt, now, rel_id, user_id ?? null);
        } else {
            await q.ins_waypoint.run(
                mem_id,
                rel_id,
                user_id ?? null,
                base_wt,
                now,
                now,
            );
        }
    }
}
export async function expand_via_waypoints(
    init_res: string[],
    user_id?: string | null,
    max_exp: number = 10,
): Promise<Array<{ id: string; weight: number; path: string[] }>> {
    const exp: Array<{ id: string; weight: number; path: string[] }> = [];
    const vis = new Set<string>();
    for (const id of init_res) {
        exp.push({ id, weight: 1.0, path: [id] });
        vis.add(id);
    }
    const q_arr = [...exp];
    let exp_cnt = 0;
    while (q_arr.length > 0 && exp_cnt < max_exp) {
        const cur = q_arr.shift()!;
        const neighs = await q.get_neighbors.all(cur.id, user_id ?? undefined);
        for (const neigh of neighs) {
            if (vis.has(neigh.dst_id)) continue;
            const neigh_wt = Math.min(1.0, Math.max(0, neigh.weight || 0));
            const exp_wt = cur.weight * neigh_wt * 0.8;
            if (exp_wt < 0.1) continue;
            const exp_item = {
                id: neigh.dst_id,
                weight: exp_wt,
                path: [...cur.path, neigh.dst_id],
            };
            exp.push(exp_item);
            vis.add(neigh.dst_id);
            q_arr.push(exp_item);
            exp_cnt++;
        }
    }
    return exp;
}

export async function reinforce_waypoints(
    trav_path: string[],
    user_id?: string | null,
): Promise<void> {
    const now = Date.now();
    for (let i = 0; i < trav_path.length - 1; i++) {
        const src_id = trav_path[i];
        const dst_id = trav_path[i + 1];
        const wp = await q.get_waypoint.get(src_id, dst_id, user_id ?? undefined);
        if (wp) {
            const new_wt = Math.min(
                reinforcement.max_waypoint_weight,
                wp.weight + reinforcement.waypoint_boost,
            );
            await q.upd_waypoint.run(src_id, new_wt, now, dst_id, user_id ?? null);
        }
    }
}
export async function prune_weak_waypoints(): Promise<number> {
    await q.prune_waypoints.run(reinforcement.prune_threshold);
    return 0;
}
import {
    embedForSector,
    embedQueryForAllSectors,
    embedMultiSector,
    cosineSimilarity,
    bufferToVector,
    vectorToBuffer,
    EmbeddingResult,
} from "./embed";
import { chunk_text } from "../utils/chunking";
import { j } from "../utils";
import { keyword_filter_memories, extract_keywords } from "../utils/keyword";
import {
    calculateCrossSectorResonanceScore,
    applyRetrievalTraceReinforcementToMemory,
    propagateAssociativeReinforcementToLinkedNodes,
    ALPHA_LEARNING_RATE_FOR_RECALL_REINFORCEMENT,
    BETA_LEARNING_RATE_FOR_EMOTIONAL_FREQUENCY,
} from "../ops/dynamics";
export interface multi_vec_fusion_weights {
    semantic_dimension_weight: number;
    emotional_dimension_weight: number;
    procedural_dimension_weight: number;
    temporal_dimension_weight: number;
    reflective_dimension_weight: number;
}
export async function calc_multi_vec_fusion_score(
    mid: string,
    qe: Record<string, number[]>,
    w: MultiVecFusionWeights,
    user_id?: string,
): Promise<number> {
    const vecs = await vector_store.getVectorsById(mid, user_id);
    let sum = 0,
        tot = 0;
    const wm: Record<string, number> = {
        semantic: w.semantic_dimension_weight,
        emotional: w.emotional_dimension_weight,
        procedural: w.procedural_dimension_weight,
        episodic: w.temporal_dimension_weight,
        reflective: w.reflective_dimension_weight,
    };
    for (const v of vecs) {
        const qv = qe[v.sector];
        if (!qv) continue;
        const mv = v.vector;
        const sim = cosineSimilarity(qv, mv);
        const wgt = wm[v.sector] || 0.5;
        sum += sim * wgt;
        tot += wgt;
    }
    return tot > 0 ? sum / tot : 0;
}
const cache = new Map<string, { r: HsgQueryResult[]; t: number }>();
const sal_cache = new Map<string, { s: number; t: number }>();
const seg_cache = new Map<number, MemoryRow[]>();
const CACHE_MAX_SIZE = 500;
const coact_buf: Array<[string | undefined, string, string]> = [];
const TTL = 60000;
const VEC_CACHE_MAX = 1000;
let active_queries = 0;
// get_vec removed
const get_segment = async (seg: number): Promise<MemoryRow[]> => {
    if (seg_cache.has(seg)) return seg_cache.get(seg)!;
    const rows = await q.get_mem_by_segment.all(seg);
    seg_cache.set(seg, rows);
    if (seg_cache.size > CACHE_MAX_SIZE) {
        const first = seg_cache.keys().next().value;
        if (first !== undefined) seg_cache.delete(first);
    }
    return rows;
};
let hsg_interval: ReturnType<typeof setInterval> | undefined;

export const start_hsg_maintenance = () => {
    if (hsg_interval) return;
    hsg_interval = setInterval(async () => {
        if (!coact_buf.length) return;
        const pairs = coact_buf.splice(0, 50);
        const now = Date.now();
        const tau_ms = hybrid_params.tau_hours * 3600000;
        for (const [uid, a, b] of pairs) {
            try {
                const [memA, memB] = await Promise.all([
                    q.get_mem.get(a, uid),
                    q.get_mem.get(b, uid),
                ]);
                if (!memA || !memB || memA.user_id !== memB.user_id) {
                    // Skip cross-user or missing memories
                    continue;
                }
                const time_diff = Math.abs((memA.last_seen_at ?? 0) - (memB.last_seen_at ?? 0));
                const temp_fact = Math.exp(-time_diff / tau_ms);
                const wp = await q.get_waypoint.get(a, b, memA.user_id ?? undefined);
                const cur_wt = wp?.weight || 0;
                const new_wt = Math.min(
                    1,
                    cur_wt + hybrid_params.eta * (1 - cur_wt) * temp_fact,
                );
                const user_id = memA.user_id;
                await q.ins_waypoint.run(a, b, user_id, new_wt, wp?.created_at || now, now);
            } catch (e) { }
        }
    }, 1000);
}

// Auto-start unless in test mode (or let server start it explicitly? For now auto-start to preserve behavior)
if (typeof process === 'undefined' || process.env.NODE_ENV !== 'test') {
    start_hsg_maintenance();
}

export const stop_hsg_maintenance = () => {
    if (hsg_interval) {
        clearInterval(hsg_interval);
        hsg_interval = undefined;
    }
}
const get_sal = async (id: string, def_sal: number, user_id?: string): Promise<number> => {
    const c = sal_cache.get(id);
    if (c && Date.now() - c.t < TTL) return c.s;
    const m = await q.get_mem.get(id, user_id);
    const s = m?.salience ?? def_sal;
    sal_cache.set(id, { s, t: Date.now() });
    if (sal_cache.size > CACHE_MAX_SIZE) {
        const first = sal_cache.keys().next().value;
        if (first !== undefined) sal_cache.delete(first);
    }
    return s;
};
export async function hsg_query(
    qt: string,
    k = 10,
    f?: { sectors?: string[]; minSalience?: number; user_id?: string; startTime?: number; endTime?: number },
): Promise<HsgQueryResult[]> {

    if (active_queries >= env.max_active) {
        throw new Error(
            `Rate limit: ${active_queries} active queries (max ${env.max_active})`,
        );
    }
    active_queries++;
    inc_q();
    try {
        const h = `${qt}:${k}:${JSON.stringify(f || {})}`;
        const cached = cache.get(h);
        if (cached && Date.now() - cached.t < TTL) return cached.r;
        const qc = classify_content(qt);
        const is_temporal = has_temporal_markers(qt);
        const qtk = canonical_token_set(qt);
        // Store primary sectors for scoring purposes
        const primary_sectors = [qc.primary, ...qc.additional];
        // Determine which sectors to search
        let ss: string[];
        if (f?.sectors?.length) {
            // User explicitly requested specific sectors
            ss = f.sectors;
        } else {
            // IMPORTANT: Search ALL sectors to enable cross-sector retrieval
            ss = [...sectors];
        }
        if (!ss.length) ss.push("semantic");

        // Batch embed all sectors in one API call
        const qe = await embedQueryForAllSectors(qt, ss);

        // Refine query classification using Learned Classifier if available
        if (f?.user_id) {
            try {
                const model_data = await q.get_classifier_model.get(f.user_id);
                if (model_data) {
                    const model: ClassifierModel = {
                        ...model_data,
                        weights: JSON.parse(model_data.weights),
                        biases: JSON.parse(model_data.biases),
                    };
                    const emb_res_for_mean: EmbeddingResult[] = Object.entries(qe).map(([sector, vector]) => ({
                        sector,
                        vector,
                        dim: vector.length
                    }));
                    const q_mean = calc_mean_vec(emb_res_for_mean, ss);
                    const learned_qc = LearnedClassifier.predict(q_mean, model);
                    if (learned_qc.confidence > 0.5) {
                        if (env.verbose) console.log(`[HSG] Query classification refined for ${f.user_id}: ${qc.primary} -> ${learned_qc.primary}`);
                        qc.primary = learned_qc.primary;
                        qc.additional = Array.from(new Set([...qc.additional, ...learned_qc.additional]));
                    }
                }
            } catch (e) { /* ignore */ }
        }

        const w: multi_vec_fusion_weights = {
            semantic_dimension_weight: qc.primary === "semantic" ? 1.2 : 0.8,
            emotional_dimension_weight: qc.primary === "emotional" ? 1.5 : 0.6,
            procedural_dimension_weight:
                qc.primary === "procedural" ? 1.3 : 0.7,
            temporal_dimension_weight: qc.primary === "episodic" ? 1.4 : 0.7,
            reflective_dimension_weight:
                qc.primary === "reflective" ? 1.1 : 0.5,
        };
        const sr: Record<
            string,
            Array<{ id: string; similarity: number }>
        > = {};
        for (const s of ss) {
            const qv = qe[s];
            const results = await vector_store.searchSimilar(s, qv, k * 3, f?.user_id);
            sr[s] = results.map(r => ({ id: r.id, similarity: r.score }));
        }
        const all_sims = Object.values(sr).flatMap((r) =>
            r.slice(0, 8).map((x) => x.similarity),
        );
        const avg_top = all_sims.length
            ? all_sims.reduce((a, b) => a + b, 0) / all_sims.length
            : 0;
        const adapt_exp = Math.ceil(0.3 * k * (1 - avg_top));
        const eff_k = k + adapt_exp;
        const high_conf = avg_top >= 0.55;
        const ids = new Set<string>();
        for (const r of Object.values(sr)) for (const x of r) ids.add(x.id);
        const exp = high_conf
            ? []
            : await expand_via_waypoints(Array.from(ids), f?.user_id, k * 2);
        for (const e of exp) ids.add(e.id);

        let keyword_scores = new Map<string, number>();
        if (tier === "hybrid") {
            const all_mems = await Promise.all(
                Array.from(ids).map(async (id) => {
                    const m = await q.get_mem.get(id, f?.user_id);
                    return m ? { id, content: m.content } : null;
                }),
            );
            const valid_mems = all_mems.filter((m) => m !== null) as Array<{
                id: string;
                content: string;
            }>;
            keyword_scores = await keyword_filter_memories(
                qt,
                valid_mems,
                0.05,
            );
        }

        const res: HsgQueryResult[] = [];
        for (const mid of Array.from(ids)) {
            const m = await q.get_mem.get(mid, f?.user_id);
            if (!m || (f?.minSalience && (m.salience ?? 0) < f.minSalience)) continue;

            // Decrypt content for processing and return
            m.content = await get_encryption().decrypt(m.content);

            if (f?.user_id && m.user_id !== f.user_id) continue;
            if (f?.startTime && (m.created_at ?? 0) < f.startTime) continue;
            if (f?.endTime && (m.created_at ?? 0) > f.endTime) continue;
            const mvf = await calc_multi_vec_fusion_score(mid, qe, w, f?.user_id);
            const csr = await calculateCrossSectorResonanceScore(
                m.primary_sector,
                qc.primary,
                mvf,
            );
            let bs = csr,
                bsec = m.primary_sector;
            for (const [sec, rr] of Object.entries(sr)) {
                const mat = rr.find((r) => r.id === mid);
                if (mat && mat.similarity > bs) {
                    bs = mat.similarity;
                    bsec = sec;
                }
            }

            // Apply sector relationship penalty for cross-sector results
            const mem_sector = m.primary_sector;
            const query_sector = qc.primary;
            let sector_penalty = 1.0;
            if (mem_sector !== query_sector && !primary_sectors.includes(mem_sector)) {
                // Apply penalty based on sector relationship strength
                sector_penalty = sector_relationships[query_sector]?.[mem_sector] || 0.3;
            }
            const adjusted_sim = bs * sector_penalty;

            const em = exp.find((e: { id: string }) => e.id === mid);
            // Clamp waypoint weight to valid range [0, 1] - protect against corrupted data
            const ww = Math.min(1.0, Math.max(0, em?.weight || 0));
            const last_seen = m.last_seen_at ?? 0;
            const ds = (Date.now() - last_seen) / 86400000;
            const sal = calc_decay(m.primary_sector, m.salience ?? 0.5, ds);
            const mtk = canonical_token_set(m.content);
            const tok_ov = compute_token_overlap(qtk, mtk);
            const rec_sc = calc_recency_score(last_seen);

            // Calculate tag match score
            const tag_match = await compute_tag_match_score(mid, qtk, f?.user_id);

            const keyword_boost =
                tier === "hybrid"
                    ? (keyword_scores.get(mid) || 0) * env.keyword_boost
                    : 0;
            const fs = compute_hybrid_score(
                adjusted_sim,
                tok_ov,
                ww,
                rec_sc,
                keyword_boost,
                tag_match,
            );
            const msec = await vector_store.getVectorsById(mid, f?.user_id);
            const sl = msec.map((v) => v.sector);
            res.push({
                id: mid,
                content: m.content,
                score: fs,
                sectors: sl,
                primary_sector: m.primary_sector,
                path: em?.path || [mid],
                salience: sal,
                last_seen_at: m.last_seen_at ?? 0,
                tags: typeof m.tags === 'string' ? (m.tags.startsWith('[') || m.tags.startsWith('{') ? JSON.parse(m.tags) : [m.tags]) : (m.tags || []),
                meta: typeof m.meta === 'string' ? (m.meta.startsWith('{') ? JSON.parse(m.meta) : { content: m.meta }) : (m.meta || {}),
            });
        }
        res.sort((a, b) => b.score - a.score);
        const top_cands = res.slice(0, eff_k);
        if (top_cands.length > 0) {
            const scores = top_cands.map((r) => r.score);
            const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
            const variance =
                scores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) /
                scores.length;
            const stdDev = Math.sqrt(variance);
            for (const r of top_cands) {
                r.score = (r.score - mean) / (stdDev + hybrid_params.epsilon);
            }
            top_cands.sort((a, b) => b.score - a.score);
        }
        const top = top_cands.slice(0, k);
        const tids = top.map((r) => r.id);

        // Update feedback scores for returned memories (simple learning)
        for (const r of top) {
            const cur_fb = (await q.get_mem.get(r.id, f?.user_id))?.feedback_score || 0;
            const new_fb = cur_fb * 0.9 + r.score * 0.1; // Exponential moving average
            await q.upd_feedback.run(r.id, new_fb, f?.user_id);
        }

        for (let i = 0; i < tids.length; i++) {
            for (let j = i + 1; j < tids.length; j++) {
                const [a, b] = [tids[i], tids[j]].sort();
                coact_buf.push([f?.user_id, a, b]);
            }
        }
        for (const r of top) {
            const rsal = await applyRetrievalTraceReinforcementToMemory(
                r.id,
                r.salience,
            );
            await q.upd_seen.run(r.id, Date.now(), rsal, Date.now(), f?.user_id);
            if (r.path.length > 1) {
                await reinforce_waypoints(r.path, f?.user_id);
                const wps = await q.get_waypoints_by_src.all(r.id, f?.user_id);
                const lns = wps.map((wp: any) => ({
                    target_id: wp.dst_id,
                    weight: wp.weight,
                }));
                const pru =
                    await propagateAssociativeReinforcementToLinkedNodes(
                        r.id,
                        rsal,
                        lns,
                    );
                for (const u of pru) {
                    const now = Date.now();
                    const decay_fact = Math.exp(-0.02 * ((now - (r.last_seen_at ?? now)) / 86400000));
                    const ctx_boost =
                        hybrid_params.gamma *
                        (rsal - (r.salience ?? 0.5)) *
                        decay_fact;
                    const new_sal = Math.max(
                        0,
                        Math.min(1, (r.salience ?? 0.5) + ctx_boost),
                    );

                    await q.upd_seen.run(
                        u.node_id,
                        now,
                        new_sal,
                        now,
                        f?.user_id,
                    );
                }
            }
        }

        for (const r of top_cands) {
            on_query_hit(r.id, r.primary_sector, f?.user_id, (text) =>
                embedForSector(text, r.primary_sector),
            ).catch(() => { });
        }

        cache.set(h, { r: top_cands, t: Date.now() });
        if (cache.size > CACHE_MAX_SIZE) {
            const first = cache.keys().next().value;
            if (first !== undefined) cache.delete(first);
        }
        return top_cands;
    } finally {
        active_queries--;
        dec_q();
    }
}
export async function run_decay_process(): Promise<{
    processed: number;
    decayed: number;
}> {
    const mems = await q.all_mem.all(10000, 0);
    let p = 0,
        d = 0;
    for (const m of mems) {
        const last_seen = m.last_seen_at ?? m.created_at ?? Date.now();
        const ds = (Date.now() - last_seen) / 86400000;
        const sal = m.salience ?? 0.5;
        const ns = calc_decay(m.primary_sector, sal, ds);
        if (ns !== sal) {
            await q.upd_seen.run(m.id, last_seen, ns, Date.now());
            d++;
        }
        p++;
    }
    if (d > 0) await log_maint_op("decay", d);
    return { processed: p, decayed: d };
}

// Helper to ensure user exists
async function ensure_user_exists(user_id: string): Promise<void> {
    try {
        const existing = await q.get_user.get(user_id);
        if (!existing) {
            await q.ins_user.run(
                user_id,
                "User profile initializing...", // Initial summary
                0, // Reflection count
                Date.now(),
                Date.now()
            );
        }
    } catch (error) {
        console.error(`[HSG] Failed to ensure user ${user_id} exists:`, error);
        // Don't throw, proceed with memory creation (legacy behavior)
    }
}

export async function add_hsg_memory(
    content: string,
    tags?: string,
    metadata?: any,
    user_id?: string,
): Promise<{
    id: string;
    primary_sector: string;
    sectors: string[];
    chunks?: number;
    deduplicated?: boolean;
}> {
    const simhash = compute_simhash(content);
    const existing = await q.get_mem_by_simhash.get(simhash, user_id);
    if (existing?.simhash && hamming_dist(simhash, existing.simhash) <= 3) {
        const now = Date.now();
        const existing_sal = existing.salience ?? 0.5;
        const boosted_sal = Math.min(1, existing_sal + 0.15);
        await q.upd_seen.run(existing.id, now, boosted_sal, now);
        return {
            id: existing.id,
            primary_sector: existing.primary_sector,
            sectors: [existing.primary_sector],
            deduplicated: true,
        };
    }
    const id = globalThis.crypto.randomUUID();
    const now = Date.now();

    // Ensure user exists in the users table
    if (user_id) {
        await ensure_user_exists(user_id);
    }

    const chunks = chunk_text(content);
    const use_chunking = chunks.length > 1;
    const classification = classify_content(content, metadata);
    const all_sectors = [classification.primary, ...classification.additional];

    // Pre-calculate embeddings outside the transaction to avoid holding locks during network calls
    const emb_res = await embedMultiSector(
        id,
        content,
        all_sectors,
        use_chunking ? chunks : undefined,
        user_id,
    );
    const mean_vec = calc_mean_vec(emb_res, all_sectors);

    // Refine classification using Learned Classifier if available
    if (user_id) {
        try {
            const model_data = await q.get_classifier_model.get(user_id);
            if (model_data) {
                const model: ClassifierModel = {
                    ...model_data,
                    weights: JSON.parse(model_data.weights),
                    biases: JSON.parse(model_data.biases),
                };
                const learned_class = LearnedClassifier.predict(mean_vec, model);
                if (learned_class.confidence > 0.6 && learned_class.primary !== classification.primary) {
                    if (env.verbose) {
                        console.log(`[HSG] Overriding classification for ${user_id}: ${classification.primary} -> ${learned_class.primary} (conf: ${learned_class.confidence.toFixed(2)})`);
                    }
                    classification.primary = learned_class.primary;
                    classification.confidence = learned_class.confidence;
                    // If the new primary sector hasn't been embedded yet, we should probably do it
                    if (!all_sectors.includes(classification.primary)) {
                        all_sectors.push(classification.primary);
                        const new_emb = await embedMultiSector(id, content, [classification.primary], use_chunking ? chunks : undefined, user_id);
                        emb_res.push(...new_emb);
                        // Recalculate mean_vec with the new primary sector
                        const updated_mean = calc_mean_vec(emb_res, all_sectors);
                        mean_vec.splice(0, mean_vec.length, ...updated_mean);
                    }
                }
            }
        } catch (e) {
            if (env.verbose) console.error(`[HSG] Error using learned classifier:`, e);
        }
    }

    const mean_vec_buf = vectorToBuffer(mean_vec);

    let comp_buf: Buffer | null = null;
    if (tier === "smart" && mean_vec.length > 128) {
        const comp = compress_vec_for_storage(mean_vec, 128);
        comp_buf = vectorToBuffer(comp);
    }

    await transaction.begin();
    try {
        const max_seg_res = await q.get_max_segment.get();
        let cur_seg = max_seg_res?.max_seg ?? 0;
        const seg_cnt_res = await q.get_segment_count.get(cur_seg);
        const seg_cnt = seg_cnt_res?.c ?? 0;
        if (seg_cnt >= env.seg_size) {
            cur_seg++;
            console.error(
                `[HSG] Rotated to segment ${cur_seg} (previous segment full: ${seg_cnt} memories)`,
            );
        }
        const stored_content = extract_essence(
            content,
            classification.primary,
            env.summary_max_length,
        );
        const sec_cfg = sector_configs[classification.primary];
        const init_sal = Math.max(
            0,
            Math.min(1, 0.4 + 0.1 * classification.additional.length),
        );

        // Encrypt content before storage
        const encrypted_content = await get_encryption().encrypt(stored_content);

        // Use the full INSERT with all pre-calculated data
        await q.ins_mem.run(
            id,
            user_id || "anonymous",
            cur_seg,
            encrypted_content,
            simhash,
            classification.primary,
            tags || "",
            JSON.stringify(metadata || {}),
            now,
            now,
            now,
            init_sal,
            sec_cfg.decay_lambda,
            1,
            mean_vec.length,
            mean_vec_buf,
            comp_buf,
            0, // feedback_score
        );

        for (const result of emb_res) {
            await vector_store.storeVector(
                id,
                result.sector,
                result.vector,
                result.dim,
                user_id || "anonymous",
            );
        }

        await create_single_waypoint(id, mean_vec, now, user_id);
        await transaction.commit();
        return {
            id,
            primary_sector: classification.primary,
            sectors: all_sectors,
            chunks: chunks.length,
        };
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
}
export async function reinforce_memory(
    id: string,
    boost: number = 0.1,
    user_id?: string,
): Promise<void> {
    const mem = await q.get_mem.get(id, user_id);
    if (!mem) throw new Error(`Memory ${id} not found`);
    const mem_sal = mem.salience ?? 0.5;
    const new_sal = Math.min(reinforcement.max_salience, mem_sal + boost);
    await q.upd_seen.run(id, Date.now(), new_sal, Date.now(), user_id);
    if (new_sal > 0.8) await log_maint_op("consolidate", 1);
}
export async function update_memory(
    id: string,
    content?: string,
    tags?: string[],
    metadata?: any,
    user_id?: string,
): Promise<{ id: string; updated: boolean }> {
    const mem = await q.get_mem.get(id, user_id);
    if (!mem) throw new Error(`Memory ${id} not found`);

    // Decrypt current content to compare with new content
    const current_plaintext = await get_encryption().decrypt(mem.content);

    const new_content = content !== undefined ? content : current_plaintext;
    const new_tags = tags !== undefined ? j(tags) : mem.tags || "[]";
    const new_meta = metadata !== undefined ? j(metadata) : mem.meta || "{}";

    let emb_res: EmbeddingResult[] | undefined;
    let classification: SectorClassification | undefined;
    let all_sectors: string[] | undefined;
    let chunks: any[] | undefined;

    // Pre-calculate embeddings if content changed
    if (content !== undefined && content !== mem.content) {
        chunks = chunk_text(new_content);
        const use_chunking = chunks.length > 1;
        classification = classify_content(new_content, metadata);
        all_sectors = [classification.primary, ...classification.additional];
        emb_res = await embedMultiSector(
            id,
            new_content,
            all_sectors,
            use_chunking ? chunks : undefined,
            user_id,
        );
    }

    await transaction.begin();
    try {
        if (content !== undefined && content !== mem.content && emb_res && classification && all_sectors) {
            await vector_store.deleteVectors(id);
            for (const result of emb_res) {
                await vector_store.storeVector(
                    id,
                    result.sector,
                    result.vector,
                    result.dim,
                    user_id || mem.user_id || "anonymous",
                );
            }
            const mean_vec = calc_mean_vec(emb_res, all_sectors);
            const mean_vec_buf = vectorToBuffer(mean_vec);
            await q.upd_mean_vec.run(id, mean_vec.length, mean_vec_buf, user_id || undefined);

            const encrypted_new_content = await get_encryption().encrypt(new_content);
            await q.upd_mem_with_sector.run(
                encrypted_new_content,
                classification.primary,
                new_tags,
                new_meta,
                Date.now(),
                id,
                user_id || undefined,
            );
        } else {
            // Check if we need to re-encrypt (e.g. if we are using original encrypted content or new encrypted content)
            // If content didn't change, we use mem.content (which is ALREADY encrypted in DB query result)
            // If we re-encrypt, we get a new IV, which is safer but not strictly required if plaintext is same.
            // However, `mem.content` is the RAW DB value (encrypted).
            // `new_content` matches `current_plaintext` here.

            const content_to_store = (content !== undefined)
                ? await get_encryption().encrypt(new_content)
                : mem.content;

            await q.upd_mem.run(
                content_to_store,
                new_tags,
                new_meta,
                Date.now(),
                id,
                user_id || undefined,
            );
        }
        await transaction.commit();
        return { id, updated: true };
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
}
