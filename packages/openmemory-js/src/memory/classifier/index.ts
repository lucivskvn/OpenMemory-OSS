import { embed } from "../embed";
import { q } from "../../core/db";

export interface ISectorClassifier {
    train(trainingData: { text: string; sector: string }[]): Promise<void>;
    classify(text: string): Promise<string>;
}

const SECTOR_CENTROIDS_META_KEY = "_sector_centroids";

export class LearnedSectorClassifier implements ISectorClassifier {
    async train(trainingData: { text: string; sector: string }[]): Promise<void> {
        if (!trainingData.length) return;

        const centroids: Record<string, number[]> = {};

        // O(n) mapping
        const groupedData = trainingData.reduce((acc, curr) => {
            if (!acc[curr.sector]) acc[curr.sector] = [];
            acc[curr.sector].push(curr);
            return acc;
        }, {} as Record<string, {text: string, sector: string}[]>);

        for (const [sector, sectorData] of Object.entries(groupedData)) {
            const vectors = await Promise.all(
                sectorData.map(async (d) => await embed(d.text))
            );

            // Compute mean vector
            const dim = vectors[0].length;
            const centroid = new Array(dim).fill(0);
            for (const vec of vectors) {
                for (let i = 0; i < dim; i++) {
                    centroid[i] += vec[i];
                }
            }
            for (let i = 0; i < dim; i++) {
                centroid[i] /= vectors.length;
            }

            centroids[sector] = centroid;
        }

        // Save to DB in stats or temporal facts? We can store it as a system meta object.
        // There is no dedicated system config table, let's use user summary for a system user "system_classifier"
        const centroidsStr = JSON.stringify(centroids);
        const existing = await q.get_user.get("system_classifier");
        if (existing) {
            await q.upd_user_summary.run("system_classifier", centroidsStr, Date.now());
        } else {
            await q.ins_user.run("system_classifier", centroidsStr, 0, Date.now(), Date.now());
        }
    }

    async classify(text: string): Promise<string> {
        const userRow = await q.get_user.get("system_classifier");
        if (!userRow || !userRow.summary) {
            return "semantic"; // default fallback
        }

        let centroids: Record<string, number[]>;
        try {
            centroids = JSON.parse(userRow.summary);
        } catch {
            return "semantic";
        }

        const emb = await embed(text);
        const vector = emb;

        let bestSector = "semantic";
        let bestSim = -Infinity;

        for (const [sector, centroid] of Object.entries(centroids)) {
            const sim = this.cosineSimilarity(vector, centroid);
            if (sim > bestSim) {
                bestSim = sim;
                bestSector = sector;
            }
        }

        return bestSector;
    }

    private cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length) return 0;
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }
}

export const classifier = new LearnedSectorClassifier();
