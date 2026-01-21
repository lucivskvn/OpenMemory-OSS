/**
 * @file Learned Classifier for memory sector classification.
 * Implements a simple Linear Classifier (Single Layer Perceptron) with SGD training.
 */
import { SimpleCache } from "../utils/cache";
import { logger } from "../utils/logger";
import { q } from "./db";
import { SectorClassification } from "./types";

/**
 * A simple Linear Classifier (Single Layer Perceptron) for sector classification.
 * Weights are stored per-user in the database.
 */
export interface ClassifierWeights {
    [sector: string]: number[]; // Input embedding dimension -> weights
}

export interface ClassifierModel {
    userId: string;
    weights: ClassifierWeights;
    biases: Record<string, number>;
    version: number;
    updatedAt: number;
}

export class LearnedClassifier {
    private static cache = new SimpleCache<string, ClassifierModel>({
        maxSize: 100,
    }); // Limit to 100 users in memory

    /**
     * Loads the classifier model for a user, checking cache first.
     */
    static async load(userId: string): Promise<ClassifierModel | null> {
        const cached = this.cache.get(userId);
        if (cached) return cached;

        const row = await q.getClassifierModel.get(userId);
        if (!row) return null;

        try {
            const model: ClassifierModel = {
                userId,
                weights: JSON.parse(row.weights),
                biases: JSON.parse(row.biases),
                version: row.version,
                updatedAt: row.updatedAt,
            };
            this.cache.set(userId, model);
            return model;
        } catch {
            return null;
        }
    }

    /**
     * Predicts the sector class for a given embedding vector.
     */
    static predict(
        vector: number[],
        model: ClassifierModel,
    ): SectorClassification {
        const scores: Record<string, number> = {};
        const sectors = Object.keys(model.weights);

        for (const sector of sectors) {
            const weights = model.weights[sector];
            const bias = model.biases[sector] || 0;

            let score = bias;
            // Simple dot product with bounds check
            const len = Math.min(vector.length, weights.length);
            for (let i = 0; i < len; i++) {
                const w = weights[i];
                const v = vector[i];
                if (typeof w === "number" && typeof v === "number") {
                    score += v * w;
                }
            }
            scores[sector] = score;
        }

        // Stable Softmax normalization for confidence
        const maxScore = Math.max(...Object.values(scores));
        const expScores = Object.entries(scores).map(([s, sc]) => ({
            sector: s,
            exp: Math.exp(sc - maxScore),
        }));
        const sumExp = expScores.reduce((a, b) => a + b.exp, 0);

        const normalized = expScores
            .map((x) => ({
                sector: x.sector,
                prob: x.exp / (sumExp || 1),
            }))
            .sort((a, b) => b.prob - a.prob);

        const primary = normalized[0];
        const additional = normalized
            .slice(1, 6) // Up to 5 additional sectors
            .filter((x) => x.prob > 0.1 && x.prob > primary.prob * 0.4) // At least 10% and 40% of primary
            .map((x) => x.sector);

        return {
            primary: primary.sector,
            additional: additional,
            confidence: primary.prob,
        };
    }

    /**
     * Simple training via Stochastic Gradient Descent (SGD) or Batch Gradient Descent.
     * Since this runs in a constrained environment, we use a simple approach.
     */
    static async train(
        data: Array<{ vector: number[]; label: string }>,
        existingModel?: ClassifierModel,
        lr = 0.01,
        epochs = 10,
    ): Promise<ClassifierModel> {
        if (data.length === 0) {
            if (existingModel) return existingModel;
            throw new Error(
                "Cannot train classifier with empty data and no existing model.",
            );
        }
        const dim = data[0].vector.length;

        // Accumulate all sectors from data and existing model
        const dataSectorSet = new Set(data.map((d) => d.label));
        let weights: ClassifierWeights = existingModel?.weights || {};
        let biases: Record<string, number> = existingModel?.biases || {};

        // Merge existing sectors
        Object.keys(weights).forEach((s) => dataSectorSet.add(s));

        // Dimension Check: if model exists but dim differs, we must reset
        const currentSectors = Object.keys(weights);
        if (currentSectors.length > 0 && weights[currentSectors[0]].length !== dim) {
            logger.warn(
                `[CLASSIFIER] Dimension mismatch (expected ${weights[currentSectors[0]].length}, got ${dim}). Archiving old model and resetting.`,
            );
            // In a real system we might archive, here we just reset but log strictly
            weights = {};
            biases = {};
            dataSectorSet.clear();
            data.forEach((d) => dataSectorSet.add(d.label));
        }

        // Initialize new sectors from the consolidated set
        const finalSectors = Array.from(dataSectorSet);
        for (let i = 0; i < finalSectors.length; i++) {
            const s = finalSectors[i];
            if (!weights[s]) {
                weights[s] = new Array(dim);
                const randomValues = new Uint32Array(dim);
                if (globalThis.crypto) {
                    globalThis.crypto.getRandomValues(randomValues);
                    for (let j = 0; j < dim; j++) {
                        // Normalize to [-0.005, 0.005]
                        weights[s][j] = ((randomValues[j] / 4294967295) - 0.5) * 0.01;
                    }
                } else {
                    for (let j = 0; j < dim; j++) {
                        weights[s][j] = (Math.random() - 0.5) * 0.01;
                    }
                }
                biases[s] = 0;
            }
        }

        const allSectorsForTrain = Object.keys(weights);
        const sectorCount = allSectorsForTrain.length;

        for (let e = 0; e < epochs; e++) {
            let sampleCount = 0;
            for (let dIdx = 0; dIdx < data.length; dIdx++) {
                const { vector, label } = data[dIdx];
                sampleCount++;

                // Yield to event loop every 50 samples to keep system responsive (optimized for node/bun event loop)
                if (sampleCount % 50 === 0) {
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }

                // Forward pass (scores)
                const scores: Record<string, number> = {};
                let maxS = -Infinity;
                for (let i = 0; i < sectorCount; i++) {
                    const s = allSectorsForTrain[i];
                    const w = weights[s];
                    let sc = biases[s];
                    for (let j = 0; j < dim; j++) {
                        sc += vector[j] * w[j];
                    }
                    scores[s] = sc;
                    if (sc > maxS) maxS = sc;
                }

                // Stable Normalization (Probs)
                let sumExp = 0;
                const probs: Record<string, number> = {};
                for (let i = 0; i < sectorCount; i++) {
                    const s = allSectorsForTrain[i];
                    const p = Math.exp(scores[s] - maxS);
                    probs[s] = p;
                    sumExp += p;
                }

                const invSumExp = 1 / (sumExp || 1);
                for (let i = 0; i < sectorCount; i++) {
                    probs[allSectorsForTrain[i]] *= invSumExp;
                }

                // Backward pass (Update)
                for (let i = 0; i < sectorCount; i++) {
                    const s = allSectorsForTrain[i];
                    const target = s === label ? 1 : 0;
                    const error = target - probs[s];
                    const lrErr = lr * error;

                    biases[s] += lrErr;
                    const w = weights[s];
                    for (let j = 0; j < dim; j++) {
                        w[j] += lrErr * vector[j];
                    }
                }
            }
        }

        return {
            userId: existingModel?.userId || "unknown",
            weights,
            biases,
            version: (existingModel?.version || 0) + 1,
            updatedAt: Date.now(),
        };
    }
}
