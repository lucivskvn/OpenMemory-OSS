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
    [sector: string]: Float32Array; // Input embedding dimension -> weights (typed for performance)
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
            const weightsRaw = JSON.parse(row.weights);
            const weights: ClassifierWeights = {};
            // Convert to Float32Array for performance
            for (const [s, w] of Object.entries(weightsRaw)) {
                weights[s] = new Float32Array(w as number[]);
            }

            const model: ClassifierModel = {
                userId,
                weights,
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
        vector: number[] | Float32Array,
        model: ClassifierModel,
    ): SectorClassification {
        const sectors = Object.keys(model.weights);
        const scores: Record<string, number> = {};

        let maxScore = -Infinity;

        for (const sector of sectors) {
            const weights = model.weights[sector];
            const bias = model.biases[sector] || 0;

            let score = bias;
            // Native dot product optimization
            const len = Math.min(vector.length, weights.length);
            for (let i = 0; i < len; i++) {
                score += vector[i] * weights[i];
            }
            scores[sector] = score;
            if (score > maxScore) maxScore = score;
        }

        // Stable Softmax normalization for confidence
        let sumExp = 0;
        const expPairs = sectors.map(s => {
            const e = Math.exp(scores[s] - maxScore);
            sumExp += e;
            return { s, e };
        });

        const normalized = expPairs
            .map((x) => ({
                sector: x.s,
                prob: x.e / (sumExp || 1),
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
        data: Array<{ vector: number[] | Float32Array; label: string }>,
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
            weights = {};
            biases = {};
            dataSectorSet.clear();
            data.forEach((d) => dataSectorSet.add(d.label));
        }

        // Initialize new sectors
        const finalSectors = Array.from(dataSectorSet);
        for (const s of finalSectors) {
            if (!weights[s]) {
                weights[s] = new Float32Array(dim);
                if (globalThis.crypto) {
                    const randomValues = new Uint32Array(dim);
                    globalThis.crypto.getRandomValues(randomValues);
                    for (let j = 0; j < dim; j++) {
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
            for (const { vector, label } of data) {
                sampleCount++;

                // Yield to event loop every 100 samples (increased for Float32 speed)
                if (sampleCount % 100 === 0) {
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }

                // Forward pass (scores)
                const scores: Record<string, number> = {};
                let maxS = -Infinity;
                for (const s of allSectorsForTrain) {
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
                for (const s of allSectorsForTrain) {
                    const p = Math.exp(scores[s] - maxS);
                    probs[s] = p;
                    sumExp += p;
                }

                const invSumExp = 1 / (sumExp || 1);
                for (const s of allSectorsForTrain) {
                    probs[s] *= invSumExp;
                }

                // Backward pass (Update)
                for (const s of allSectorsForTrain) {
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
