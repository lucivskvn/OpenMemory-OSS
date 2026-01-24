/**
 * Hierarchical Storage Graph (HSG) Configuration.
 * Defines sector-specific cognitive parameters and pattern matching rules.
 */
import { env } from "./cfg";
import { SectorConfig, SectorType } from "./types";

export const sectorConfigs: Record<SectorType | string, SectorConfig> = {
    episodic: {
        model: "episodic-optimized",
        decayLambda: env.decayEpisodic,
        weight: 1.2,
        patterns: [
            /\b(today|yesterday|tomorrow|last\s+(week|month|year)|next\s+(week|month|year))\b/i,
            /\b(remember\s+when|recall|that\s+time|when\s+I|I\s+was|we\s+were)\b/i,
        ],
    },
    semantic: {
        model: "text-embedding-3-small",
        decayLambda: env.decaySemantic,
        weight: 1.0,
        patterns: [
            /\b(is|are|means|defined\s+as|concept|fact|explanation|theory|logic)\b/i,
        ],
    },
    procedural: {
        model: "procedural-instruct",
        decayLambda: env.decayProcedural,
        weight: 1.1,
        patterns: [
            /\b(how\s+to|step|process|guide|instruction|workflow|method|algorithm|install|setup|configure|deploy|run|command|execute)\b/i,
            /\b(first|second|then|finally|next\s+step|start|end|finish)\b/i,
        ],
    },
    emotional: {
        model: "sentiment-aware",
        decayLambda: env.decayEmotional,
        weight: 0.9,
        patterns: [
            /\b(feel|love|hate|happy|sad|angry|excited|anxious|opinion|good|bad)\b/i,
            /!{2,}/, // Multiple exclamation marks
        ],
    },
    reflective: {
        model: "high-order-thinking",
        decayLambda: env.decayReflective,
        weight: 1.3,
        patterns: [
            /\b(think|realize|learned|understand|perspective|insight|conclusion|summary)\b/i,
            /\b(I\s+now\s+see|upon\s+reflection)\b/i,
        ],
    },
};

/**
 * Global scoring parameters for hybrid retrieval.
 */
export const scoringWeights = {
    similarity: env.scoringSimilarity ?? 1.0,
    overlap: env.scoringOverlap ?? 0.5,
    waypoint: env.scoringWaypoint ?? 0.3,
    recency: env.scoringRecency ?? 0.2,
    tagMatch: env.scoringTagMatch ?? 0.4,
    salience: env.scoringSalience ?? 0.1,
    keyword: env.scoringKeyword ?? 0.05,
};

/**
 * Parameters for waypoints and spreading activation.
 */
export const hybridParams = {
    alphaReinforce: 0.1,
    beta: 2.0,
    epsilon: 1e-6,
    tau: 0.5,
    tauHours: env.graphTemporalWindow / 3600000,
    eta: 0.2,
};

/**
 * Weights for synthetic embedding generation.
 */
export const syntheticWeights: Record<string, number> = {
    episodic: 1.3,
    semantic: 1.0,
    procedural: 1.2,
    emotional: 1.4,
    reflective: 0.9,
};
