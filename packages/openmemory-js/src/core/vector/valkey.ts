import Redis from "ioredis";
import { env } from "../config";
import { VectorStore } from "../vector_store";
import { bufferToVector, vectorToBuffer } from "../../memory/embed";

export class ValkeyVectorStore implements VectorStore {
    private client: Redis;

    constructor() {
        this.client = new Redis({
            host: env.valkey_host || "localhost",
            port: env.valkey_port || 6379,
            password: env.valkey_password,
            connectionName: "openmemory_vector_store_client",
        });
    }

    private getKey(tenant_id: string, id: string, sector: string): string {
        return `om:${tenant_id}:vector:${sector}:${id}`;
    }

    async storeVector(
        id: string,
        sector: string,
        vector: number[],
        dim: number,
        user_id?: string,
        project_id?: string,
    ): Promise<void> {
        const uid = user_id || "anonymous";
        const key = this.getKey(uid, id, sector);
        const buf = vectorToBuffer(vector);

        await this.client.hset(key, {
            v: buf,
            dim: dim,
            user_id: uid,
            project_id: project_id || "null",
            id: id,
            sector: sector,
        });
    }

    async deleteVector(id: string, sector: string, user_id?: string): Promise<void> {
        const uid = user_id || "anonymous";
        const key = this.getKey(uid, id, sector);
        await this.client.del(key);
    }

    async deleteVectors(id: string, user_id?: string): Promise<void> {
        const uid = user_id || "*";
        let cursor = "0";
        do {
            const res = await this.client.scan(
                cursor,
                "MATCH",
                `om:${uid}:vector:*:${id}`,
                "COUNT",
                100,
            );
            cursor = res[0];
            const keys = res[1];
            if (keys.length) await this.client.del(...keys);
        } while (cursor !== "0");
    }

    async searchSimilar(
        sector: string,
        queryVec: number[],
        topK: number,
        user_id?: string,
        project_id?: string,
    ): Promise<Array<{ id: string; score: number }>> {
        const indexName = `idx:${sector}`;
        const blob = vectorToBuffer(queryVec);
        const uid = user_id || "anonymous";

        try {
            // Over-fetch to allow for project_id filtering if necessary
            // In RediSearch, ideally user_id and project_id are indexed.
            const fetchK = project_id ? topK * 5 : topK;

            const res = (await this.client.call(
                "FT.SEARCH",
                indexName,
                `(@user_id:{${uid.replace(/-/g, "\\-")}}) => [KNN ${fetchK} @v $blob AS score]`,
                "PARAMS",
                "2",
                "blob",
                blob,
                "DIALECT",
                "2",
            )) as any[];

            const results: Array<{ id: string; score: number }> = [];
            for (let i = 1; i < res.length; i += 2) {
                const key = res[i] as string;
                const fields = res[i + 1] as any[];
                let id = "";
                let dist = 0;
                let vec_project_id = "";

                for (let j = 0; j < fields.length; j += 2) {
                    if (fields[j] === "id") id = fields[j + 1];
                    if (fields[j] === "score") dist = parseFloat(fields[j + 1]);
                    if (fields[j] === "project_id") vec_project_id = fields[j + 1];
                }
                if (!id) id = key.split(":").pop()!;

                const projectMatch =
                    !project_id ||
                    vec_project_id === project_id ||
                    vec_project_id === "system_global" ||
                    vec_project_id === "null" ||
                    vec_project_id === "";

                if (projectMatch) {
                    results.push({ id, score: 1 - dist });
                    if (results.length >= topK) break;
                }
            }

            return results;
        } catch (e) {
            let cursor = "0";
            const allVecs: Array<{
                id: string;
                vector: number[];
                project_id: string;
            }> = [];
            do {
                const res = await this.client.scan(
                    cursor,
                    "MATCH",
                    `om:${uid}:vector:${sector}:*`,
                    "COUNT",
                    100,
                );
                cursor = res[0];
                const keys = res[1];
                if (keys.length) {
                    const pipe = this.client.pipeline();
                    keys.forEach((k) =>
                        pipe.hmget(k, "v", "project_id"),
                    );
                    const buffers = await pipe.exec();
                    buffers?.forEach((b, idx) => {
                        if (b && b[1]) {
                            const [buf, vec_project_id] = b[1] as [Buffer, string];
                            const id = keys[idx].split(":").pop()!;

                            const projectMatch =
                                !project_id ||
                                vec_project_id === project_id ||
                                vec_project_id === "system_global" ||
                                vec_project_id === "null" ||
                                vec_project_id === "";

                            if (projectMatch) {
                                allVecs.push({
                                    id,
                                    vector: bufferToVector(buf),
                                    project_id: vec_project_id,
                                });
                            }
                        }
                    });
                }
            } while (cursor !== "0");

            const sims = allVecs.map((v) => ({
                id: v.id,
                score: this.cosineSimilarity(queryVec, v.vector),
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

    async getVector(
        id: string,
        sector: string,
        user_id?: string,
    ): Promise<{ vector: number[]; dim: number } | null> {
        const uid = user_id || "anonymous";
        const key = this.getKey(uid, id, sector);
        const res = await this.client.hmget(key, "v", "dim");
        if (!res[0]) return null;
        return {
            vector: bufferToVector(res[0] as unknown as Buffer),
            dim: parseInt(res[1] as string),
        };
    }

    async getVectorsById(
        id: string,
        user_id?: string,
    ): Promise<Array<{ sector: string; vector: number[]; dim: number }>> {
        const uid = user_id || "*";
        const results: Array<{ sector: string; vector: number[]; dim: number }> = [];
        let cursor = "0";
        do {
            const res = await this.client.scan(
                cursor,
                "MATCH",
                `om:${uid}:vector:*:${id}`,
                "COUNT",
                100,
            );
            cursor = res[0];
            const keys = res[1];
            if (keys.length) {
                const pipe = this.client.pipeline();
                keys.forEach((k) => pipe.hmget(k, "v", "dim"));
                const res = await pipe.exec();
                res?.forEach((r, idx) => {
                    if (r && r[1]) {
                        const [v, dim] = r[1] as [Buffer, string];
                        const key = keys[idx];
                        const parts = key.split(":");
                        const sector = parts[3];
                        results.push({
                            sector,
                            vector: bufferToVector(v),
                            dim: parseInt(dim),
                        });
                    }
                });
            }
        } while (cursor !== "0");
        return results;
    }

    async getVectorsBySector(
        sector: string,
        user_id?: string,
    ): Promise<Array<{ id: string; vector: number[]; dim: number }>> {
        const uid = user_id || "*";
        const results: Array<{ id: string; vector: number[]; dim: number }> = [];
        let cursor = "0";
        do {
            const res = await this.client.scan(
                cursor,
                "MATCH",
                `om:${uid}:vector:${sector}:*`,
                "COUNT",
                100,
            );
            cursor = res[0];
            const keys = res[1];
            if (keys.length) {
                const pipe = this.client.pipeline();
                keys.forEach((k) => pipe.hmget(k, "v", "dim"));
                const res = await pipe.exec();
                res?.forEach((r, idx) => {
                    if (r && r[1]) {
                        const [v, dim] = r[1] as [Buffer, string];
                        const key = keys[idx];
                        const id = key.split(":").pop()!;
                        results.push({
                            id,
                            vector: bufferToVector(v),
                            dim: parseInt(dim),
                        });
                    }
                });
            }
        } while (cursor !== "0");
        return results;
    }
}
