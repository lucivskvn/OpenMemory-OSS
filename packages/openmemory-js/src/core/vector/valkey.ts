import { VectorStore } from "../vector_store";
import Redis from "ioredis";
import { env } from "../cfg";
import { vectorToBuffer, bufferToVector } from "../../memory/embed";

export class ValkeyVectorStore implements VectorStore {
    private client: Redis;

    constructor() {
        this.client = new Redis({
            host: env.valkey_host || "localhost",
            port: env.valkey_port || 6379,
            password: env.valkey_password,
        });
    }

    private getKey(id: string, sector: string): string {
        return `vec:${sector}:${id}`;
    }

    async storeVector(id: string, sector: string, vector: number[], dim: number, user_id?: string): Promise<void> {
        const key = this.getKey(id, sector);
        const buf = vectorToBuffer(vector);
        // Store as Hash: v (blob), dim (int), user_id (string)
        await this.client.hset(key, {
            v: buf,
            dim: dim,
            user_id: user_id || "anonymous",
            id: id,
            sector: sector
        });
    }

    async deleteVector(id: string, sector: string): Promise<void> {
        const key = this.getKey(id, sector);
        await this.client.del(key);
    }

    async deleteVectors(id: string): Promise<void> {
        let cursor = "0";
        do {
            const res = await this.client.scan(cursor, "MATCH", `vec:*:${id}`, "COUNT", 100);
            cursor = res[0];
            const keys = res[1];
            if (keys.length) await this.client.del(...keys);
        } while (cursor !== "0");
    }

    async searchSimilar(sector: string, queryVec: number[], topK: number, user_id?: string): Promise<Array<{ id: string; score: number }>> {
        const indexName = `idx:${sector}`;
        const blob = vectorToBuffer(queryVec);

        let query = user_id ? `(@user_id:{${user_id}})` : "(*)";
        query += ` *=>[KNN ${topK} @v $blob AS score]`;

        try {
            const res = await this.client.call(
                "FT.SEARCH",
                indexName,
                query,
                "PARAMS",
                "2",
                "blob",
                blob,
                "DIALECT",
                "2"
            ) as unknown[];

            const results: Array<{ id: string; score: number }> = [];
            for (let i = 1; i < res.length; i += 2) {
                const key = res[i] as string;
                const fields = res[i + 1] as unknown[];
                let id = "";
                let dist = 0;
                for (let j = 0; j < fields.length; j += 2) {
                    if (fields[j] === "id") id = fields[j + 1] as string;
                    if (fields[j] === "score") dist = parseFloat(fields[j + 1] as string);
                }
                if (!id) id = key.split(":").pop()!;
                results.push({ id, score: 1 - dist });
            }
            return results;
        } catch (e) {
            console.warn(`[Valkey] FT.SEARCH failed for ${sector}, falling back to scan (slow):`, e);
            let cursor = "0";
            const allVecs: Array<{ id: string; vector: number[] }> = [];
            do {
                const res = await this.client.scan(cursor, "MATCH", `vec:${sector}:*`, "COUNT", 100);
                cursor = res[0];
                const keys = res[1];
                if (keys.length) {
                    const pipe = this.client.pipeline();
                    keys.forEach(k => pipe.hmget(k, "v", "user_id"));
                    const pipe_results = await pipe.exec();
                    pipe_results?.forEach((r, idx) => {
                        if (r && r[1]) {
                            const [vBuf, uId] = r[1] as [Buffer, string];
                            if (user_id && uId !== user_id) return;
                            const id = keys[idx].split(":").pop()!;
                            allVecs.push({ id, vector: bufferToVector(vBuf) });
                        }
                    });
                }
            } while (cursor !== "0");

            const sims = allVecs.map(v => ({
                id: v.id,
                score: this.cosineSimilarity(queryVec, v.vector)
            }));
            sims.sort((a, b) => b.score - a.score);
            return sims.slice(0, topK);
        }
    }

    private cosineSimilarity(a: number[], b: number[]) {
        if (a.length !== b.length) return 0;
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
    }

    async getVector(id: string, sector: string, user_id?: string): Promise<{ vector: number[]; dim: number } | null> {
        const key = this.getKey(id, sector);
        const res = await this.client.hmget(key, "v", "dim", "user_id");
        if (!res[0]) return null;
        if (user_id && res[2] !== user_id) return null;
        return {
            vector: bufferToVector(res[0] as unknown as Buffer),
            dim: parseInt(res[1] as string)
        };
    }

    async getVectorsById(id: string, user_id?: string): Promise<Array<{ sector: string; vector: number[]; dim: number }>> {
        const results: Array<{ sector: string; vector: number[]; dim: number }> = [];
        let cursor = "0";
        do {
            const res = await this.client.scan(cursor, "MATCH", `vec:*:${id}`, "COUNT", 100);
            cursor = res[0];
            const keys = res[1];
            if (keys.length) {
                const pipe = this.client.pipeline();
                keys.forEach(k => pipe.hmget(k, "v", "dim", "user_id"));
                const res_pipe = await pipe.exec();
                res_pipe?.forEach((r, idx) => {
                    if (r && r[1]) {
                        const [v, dim, uid] = r[1] as [Buffer, string, string];
                        if (user_id && uid !== user_id) return;
                        const key = keys[idx];
                        const parts = key.split(":");
                        const sector = parts[1];
                        results.push({
                            sector,
                            vector: bufferToVector(v),
                            dim: parseInt(dim)
                        });
                    }
                });
            }
        } while (cursor !== "0");
        return results;
    }

    async getVectorsBySector(sector: string, user_id?: string): Promise<Array<{ id: string; vector: number[]; dim: number }>> {
        const results: Array<{ id: string; vector: number[]; dim: number }> = [];
        let cursor = "0";
        do {
            const res = await this.client.scan(cursor, "MATCH", `vec:${sector}:*`, "COUNT", 100);
            cursor = res[0];
            const keys = res[1];
            if (keys.length) {
                const pipe = this.client.pipeline();
                keys.forEach(k => pipe.hmget(k, "v", "dim", "user_id"));
                const res_pipe = await pipe.exec();
                res_pipe?.forEach((r, idx) => {
                    if (r && r[1]) {
                        const [v, dim, u] = r[1] as [Buffer, string, string];
                        if (user_id && u !== user_id) return;
                        if (!user_id && u && u !== "anonymous" && u !== null) return;

                        const key = keys[idx];
                        const id = key.split(":").pop()!;
                        results.push({
                            id,
                            vector: bufferToVector(v),
                            dim: parseInt(dim)
                        });
                    }
                });
            }
        } while (cursor !== "0");
        return results;

    }

    async disconnect(): Promise<void> {
        await this.client.quit();
    }
}
