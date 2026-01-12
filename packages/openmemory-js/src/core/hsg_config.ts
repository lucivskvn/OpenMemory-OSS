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
