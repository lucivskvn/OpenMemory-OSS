
import { env } from "./cfg";
import { sector_class } from "../memory/hsg";

/**
 * A simple Linear Classifier (Single Layer Perceptron) for sector classification.
 * Weights are stored per-user in the database.
 */
export interface ClassifierWeights {
    [sector: string]: number[]; // Input embedding dimension -> weights
}

export interface ClassifierModel {
    user_id: string;
    weights: ClassifierWeights;
    biases: Record<string, number>;
    version: number;
    updated_at: number;
}

export class LearnedClassifier {
    private static cache: Map<string, ClassifierModel> = new Map();

    /**
     * Predicts the sector class for a given embedding vector.
     */
    static predict(vector: number[], model: ClassifierModel): sector_class {
        const scores: Record<string, number> = {};
        const sectors = Object.keys(model.weights);

        for (const sector of sectors) {
            const weights = model.weights[sector];
            const bias = model.biases[sector] || 0;

            let score = bias;
            // Simple dot product
            for (let i = 0; i < Math.min(vector.length, weights.length); i++) {
                score += vector[i] * weights[i];
            }
            scores[sector] = score;
        }

        // Softmax-like normalization for confidence
        const expScores = Object.entries(scores).map(([s, sc]) => ({
            sector: s,
            exp: Math.exp(sc),
        }));
        const sumExp = expScores.reduce((a, b) => a + b.exp, 0);

        const normalized = expScores
            .map((x) => ({
                sector: x.sector,
                prob: x.exp / (sumExp || 1),
            }))
            .sort((a, b) => b.prob - a.prob);

        const primary = normalized[0];
        const additional = normalized.slice(1, 3).filter(x => x.prob > 0.2).map(x => x.sector);

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
    static train(
        data: Array<{ vector: number[]; label: string }>,
        existing_model?: ClassifierModel,
        lr = 0.01,
        epochs = 10,
    ): ClassifierModel {
        const dim = data[0]?.vector.length || 1536;
        const sectors = Array.from(new Set(data.map((d) => d.label)));

        const weights: ClassifierWeights = existing_model?.weights || {};
        const biases: Record<string, number> = existing_model?.biases || {};

        // Initialize new sectors if any
        for (const sector of sectors) {
            if (!weights[sector]) {
                weights[sector] = new Array(dim).fill(0).map(() => (Math.random() - 0.5) * 0.01);
                biases[sector] = 0;
            }
        }

        for (let e = 0; e < epochs; e++) {
            for (const { vector, label } of data) {
                // One-hot target
                const targets: Record<string, number> = {};
                for (const s of sectors) targets[s] = s === label ? 1 : 0;

                // Forward pass (scores)
                const scores: Record<string, number> = {};
                for (const s of sectors) {
                    let sc = biases[s];
                    for (let i = 0; i < dim; i++) sc += vector[i] * weights[s][i];
                    scores[s] = sc;
                }

                // Normalization (Probs)
                const sumExp = Object.values(scores).reduce((a, b) => a + Math.exp(b), 0);
                const probs: Record<string, number> = {};
                for (const s of sectors) probs[s] = Math.exp(scores[s]) / sumExp;

                // Backward pass (Update)
                for (const s of sectors) {
                    const error = targets[s] - probs[s];
                    biases[s] += lr * error;
                    for (let i = 0; i < dim; i++) {
                        weights[s][i] += lr * error * vector[i];
                    }
                }
            }
        }

        return {
            user_id: existing_model?.user_id || "unknown",
            weights,
            biases,
            version: (existing_model?.version || 0) + 1,
            updated_at: Date.now(),
        };
    }
}
