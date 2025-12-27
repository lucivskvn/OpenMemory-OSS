import { VectorStore } from "../vector_store";
import { RedisClient } from "bun";
import { env } from "../cfg";
import { log } from "../log";
import { vectorToBuffer, bufferToVector } from "../../memory/embed";

export class ValkeyVectorStore implements VectorStore {
    private client: RedisClient;

    // For testability you can provide a pre-initialized Redis client
    constructor(client?: RedisClient) {
        if (client) {
            this.client = client;
            return;
        }

        // Bun's RedisClient works with URL or options but URL is main
        const url = `redis://${env.valkey_password ? `:${env.valkey_password}@` : ""}${env.valkey_host || "localhost"}:${env.valkey_port || 6379}`;
        this.client = new RedisClient(url, {
            retryStrategy: (times) => Math.min(times * 50, 2000), // Simple exponential backoff
            connectTimeout: 10000,
        });
    }

    private getKey(id: string, sector: string): string {
        return `vec:${sector}:${id}`;
    }

    async init(): Promise<void> {
        // Create indices for each sector
        const sectors = ["episodic", "semantic", "procedural", "emotional", "reflective"];
        const dim = env.vec_dim || 1536;

        for (const sec of sectors) {
            const idx = `idx:${sec}`;
            try {
                // Check if index exists
                await this.client.send("FT.INFO", [idx]);
            } catch (e) {
                // Create index if missing
                try {
                    await this.client.send("FT.CREATE", [
                        idx,
                        "ON", "HASH",
                        "PREFIX", "1", `vec:${sec}:`,
                        "SCHEMA",
                        "user_id", "TAG",
                        "v", "VECTOR", "HNSW", "6",
                        "TYPE", "FLOAT32",
                        "DIM", dim.toString(),
                        "DISTANCE_METRIC", "COSINE"
                    ]);
                    log.info(`[Valkey] Created index ${idx}`);
                } catch (ce) {
                    log.error(`[Valkey] Failed to create index ${idx}`, { error: ce });
                }
            }
        }
    }

    async storeVector(id: string, sector: string, vector: number[], dim: number, user_id?: string): Promise<void> {
        const key = this.getKey(id, sector);
        const buf = vectorToBuffer(vector);
        // Store as Hash: v (blob), dim (int), user_id (string)
        // Bun redis uses standard commands. hset supports object or variadic.
        // But Bun redis typing might expect string for values?
        // Docs say: "All values are converted to strings".
        // Wait, Redis stores everything as bytes. But JS client usually stringifies unless it's Buffer.
        // Docs: "Bulk strings are returned as JavaScript strings... Array responses are returned as JavaScript arrays"
        // But for SETTING, we want to set a Buffer (blob).
        // Does Bun Redis support Buffer in hset?
        // RedisClient docs don't explicitly say "supports Buffer inputs".
        // But standard usage often allows it.
        // Let's assume it does or we need to encode as base64 or latin1 string.
        // vectorToBuffer returns a Buffer.
        // If Bun Redis doesn't support Buffer, this will fail.
        // However, Ioredis supported it.
        // If not, we can use `buf.toString('latin1')` (binary string).

        await this.client.hset(key, {
            v: buf.toString('latin1'), // Safe fallback for binary data in string-only clients
            dim: dim.toString(),
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
        // scan is supported
        let cursor = "0";
        do {
            // Bun Redis scan returns [cursor, keys]
            const res = await this.client.scan(cursor, "MATCH", `vec:*:${id}`, "COUNT", 100);
            cursor = res[0];
            const keys = res[1];
            if (keys.length) await this.client.del(...keys);
        } while (cursor !== "0");
    }

    async searchSimilar(sector: string, queryVec: number[], topK: number, user_id?: string): Promise<Array<{ id: string; score: number }>> {
        const indexName = `idx:${sector}`;
        const buf = vectorToBuffer(queryVec);

        try {
            const blobStr = buf.toString('latin1'); // Binary string

            // Build filter query
            let query = `*=>[KNN ${topK} @v $blob AS score]`;
            if (user_id) {
                // Pre-filter by user_id TAG
                // Syntax: (@user_id:{uid})=>[KNN ...]
                // sanitize user_id for TAG field (escape special chars if needed)
                const safe_uid = user_id.replace(/([,.<>{}\[\]"':;!@#$%^&*()\-+=~])/g, '\\$1');
                query = `(@user_id:{${safe_uid}})=>[KNN ${topK} @v $blob AS score]`;
            }

            const res = await this.client.send(
                "FT.SEARCH",
                [
                    indexName,
                    query,
                    "PARAMS",
                    "2",
                    "blob",
                    blobStr,
                    "DIALECT",
                    "2"
                ]
            ) as any[];

            const count = res[0]; // first element is count
            const results: Array<{ id: string; score: number }> = [];

            for (let i = 1; i < res.length; i += 2) {
                const key = res[i] as string;
                const fields = res[i + 1] as any[];
                let id = "";
                let dist = 0;

                for (let j = 0; j < fields.length; j += 2) {
                    if (fields[j] === "id") id = fields[j + 1];
                    if (fields[j] === "score") dist = parseFloat(fields[j + 1]);
                }

                if (!id) id = key.split(":").pop()!;
                results.push({ id, score: 1 - dist });
            }

            return results;

        } catch (e) {
            log.warn(`[Valkey] FT.SEARCH failed for ${sector}, falling back to scan (slow):`, { error: e });

            let cursor = "0";
            const allVecs: Array<{ id: string; vector: number[] }> = [];
            do {
                const res = await this.client.scan(cursor, "MATCH", `vec:${sector}:*`, "COUNT", 100);
                cursor = res[0];
                const keys = res[1];
                if (keys.length) {
                    // Pipeline is manual in Bun?
                    // "Commands are automatically pipelined by default"
                    // So we just fire off many promises.
                    const promises = keys.map(k => this.client.hget(k, "v"));
                    const values = await Promise.all(promises);

                    values.forEach((val, idx) => {
                        if (val) {
                             // Convert back from string/buffer
                             // If we stored as latin1 string, we need to convert to buffer.
                             // `bufferToVector` expects Buffer.
                             // `val` from hget might be string.
                             const buf = Buffer.from(val, 'latin1');
                             const id = keys[idx].split(":").pop()!;
                             allVecs.push({ id, vector: bufferToVector(buf) });
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

    async getVector(id: string, sector: string): Promise<{ vector: number[]; dim: number } | null> {
        const key = this.getKey(id, sector);
        const res = await this.client.hmget(key, ["v", "dim"]);
        // hmget returns array of values in order.
        if (!res[0]) return null;
        return {
            vector: bufferToVector(Buffer.from(res[0], 'latin1')),
            dim: parseInt(res[1] as string)
        };
    }

    async getVectorsById(id: string): Promise<Array<{ sector: string; vector: number[]; dim: number }>> {
        const results: Array<{ sector: string; vector: number[]; dim: number }> = [];
        let cursor = "0";
        do {
            const res = await this.client.scan(cursor, "MATCH", `vec:*:${id}`, "COUNT", 100);
            cursor = res[0];
            const keys = res[1];
            if (keys.length) {
                const promises = keys.map(k => this.client.hmget(k, ["v", "dim"]).then(vals => ({ k, vals })));
                const allRes = await Promise.all(promises);

                allRes.forEach(({ k, vals }) => {
                    if (vals && vals[0]) {
                        const v = vals[0];
                        const dim = vals[1];
                        const parts = k.split(":");
                        const sector = parts[1];
                        results.push({
                            sector,
                            vector: bufferToVector(Buffer.from(v, 'latin1')),
                            dim: parseInt(dim)
                        });
                    }
                });
            }
        } while (cursor !== "0");
        return results;
    }

    async getVectorsForMemoryIds(ids: string[]): Promise<Array<{ id: string; sector: string; vector: number[]; dim: number }>> {
        const promises = ids.map(id => this.getVectorsById(id).then(vecs => vecs.map(v => ({ id, ...v }))));
        const results = await Promise.all(promises);
        return results.flat();
    }

    async getVectorsBySector(sector: string, user_id?: string): Promise<Array<{ id: string; vector: number[]; dim: number }>> {
        const results: Array<{ id: string; vector: number[]; dim: number }> = [];
        let cursor = "0";
        do {
            const res = await this.client.scan(cursor, "MATCH", `vec:${sector}:*`, "COUNT", 100);
            cursor = res[0];
            const keys = res[1];
            if (keys.length) {
                const promises = keys.map(k => this.client.hmget(k, ["v", "dim", "user_id"]).then(vals => ({ k, vals })));
                const allRes = await Promise.all(promises);

                allRes.forEach(({ k, vals }) => {
                    if (vals && vals[0]) {
                        const v = vals[0];
                        const dim = vals[1];
                        const uid = vals[2] || "anonymous";
                        if (user_id && uid !== user_id) return;
                        const id = k.split(":").pop()!;
                        results.push({
                            id,
                            vector: bufferToVector(Buffer.from(v, 'latin1')),
                            dim: parseInt(dim)
                        });
                    }
                });
            }
        } while (cursor !== "0");
        return results;
    }

    async search(queryVec: number[], topK: number, user_id?: string): Promise<Array<{ id: string; score: number }>> {
         // Valkey search global fallback (scan all vectors)
         // This is slow but necessary if we don't have a global index or sector
         const results: Array<{ id: string; score: number }> = [];
         let cursor = "0";
         const allVecs: Array<{ id: string; vector: number[] }> = [];

         // We scan for ALL keys starting with vec:
         do {
            const res = await this.client.scan(cursor, "MATCH", `vec:*:*`, "COUNT", 100);
            cursor = res[0];
            const keys = res[1];
            if (keys.length) {
                 const promises = keys.map(k => this.client.hmget(k, ["v", "user_id"]));
                 const values = await Promise.all(promises);

                 values.forEach((val, idx) => {
                     if (val && val[0]) {
                         const uid = val[1] as string;
                         if (user_id && uid !== user_id) return;

                         const buf = Buffer.from(val[0] as string, 'latin1');
                         const id = keys[idx].split(":").pop()!;
                         allVecs.push({ id, vector: bufferToVector(buf) });
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
