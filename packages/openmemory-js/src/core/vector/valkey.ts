/**
 * Valkey/Redis Vector Store Implementation.
 * Uses RediSearch (FT.* commands) for high-performance vector similarity search.
 */
import { normalizeUserId } from "../../utils";
import { retry } from "../../utils/index";
import { logger } from "../../utils/logger";
import { bufferToVector, vectorToUint8Array } from "../../utils/vectors";
import { getRedisClient } from "../redis";
import { VectorStore } from "../vectorStore";

export class ValkeyVectorStore implements VectorStore {
    // Shared client managed by core/redis

    constructor() {
        // No-op: client is lazy loaded
    }

    private indices: Set<string> = new Set();

    private getKey(id: string, sector: string): string {
        return `vec:${sector}:${id}`;
    }

    private getValkeyId(userId?: string | null): string {
        const uid = normalizeUserId(userId);
        if (uid === undefined) return "system";
        if (uid === null) return "anonymous";
        return uid;
    }

    private async ensureIndex(sector: string, dim: number): Promise<void> {
        if (this.indices.has(sector)) return;

        const indexName = `idx:${sector}`;
        const client = getRedisClient();
        try {
            await client.call("FT.INFO", indexName);
            this.indices.add(sector);
        } catch (e: any) {
            const errMsg = e?.message || "";
            if (errMsg.includes("Unknown index") || errMsg.includes("not found")) {
                // Index does not exist, create it
                logger.info(
                    `[VALKEY] Creating index ${indexName} for sector ${sector} (dim=${dim})`,
                );
                try {
                    // We use userId as the field name in Redis too for consistency with our camelCase standardization
                    await client.call(
                        "FT.CREATE",
                        indexName,
                        "ON",
                        "HASH",
                        "PREFIX",
                        "1",
                        `vec:${sector}:`,
                        "SCHEMA",
                        "userId",
                        "TAG",
                        "id",
                        "TAG",
                        "metadata",
                        "TEXT",
                        "dim",
                        "NUMERIC",
                        "v",
                        "VECTOR",
                        "HNSW",
                        "12",
                        "TYPE",
                        "FLOAT32",
                        "DIM",
                        dim.toString(),
                        "DISTANCE_METRIC",
                        "COSINE",
                        "M", "16",
                        "EF_CONSTRUCTION", "200",
                        "EF_RUNTIME", "10"
                    );
                    this.indices.add(sector);
                } catch (createErr: any) {
                    if (createErr?.message?.includes("already exists")) {
                        // Index was created by another concurrent process
                        this.indices.add(sector);
                    } else {
                        logger.error(`[VALKEY] Failed to create index ${indexName}:`, {
                            error: createErr,
                        });
                    }
                }
            } else {
                // Some other error (e.g. connection), don't add to indices
                logger.warn(`[VALKEY] FT.INFO failed for ${indexName}`, { error: e });
            }
        }
    }

    async storeVector(
        id: string,
        sector: string,
        vector: number[],
        dim: number,
        userId?: string | null,
        metadata?: Record<string, unknown>,
    ): Promise<void> {
        await this.ensureIndex(sector, dim);
        const key = `vec:${sector}:${id}`;
        const blob = vectorToUint8Array(vector);
        const mapping: Record<string, string | Buffer> = {
            id,
            v: Buffer.from(blob),
            userId: this.getValkeyId(userId),
            metadata: metadata ? JSON.stringify(metadata) : "",
        };
        await retry(
            async () => {
                const client = getRedisClient();
                const pipe = client.pipeline();
                pipe.hset(key, mapping);
                // Reverse index: ID -> Sectors
                pipe.sadd(`idx:id_sectors:${id}`, sector);
                await pipe.exec();
            },
            { retries: 2, delay: 100 },
        );
    }

    async storeVectors(
        items: Array<{
            id: string;
            sector: string;
            vector: number[];
            dim: number;
            metadata?: Record<string, unknown>;
        }>,
        userId?: string | null,
    ): Promise<void> {
        if (items.length === 0) return;

        // Group by sector to ensure indices exist
        const sectors = new Set(items.map((i) => i.sector));
        for (const sector of sectors) {
            const firstOfSector = items.find((i) => i.sector === sector);
            if (firstOfSector)
                await this.ensureIndex(sector, firstOfSector.dim);
        }

        await retry(
            async () => {
                const client = getRedisClient();
                const pipe = client.pipeline();
                for (const item of items) {
                    const key = `vec:${item.sector}:${item.id}`;
                    const blob = vectorToUint8Array(item.vector);
                    const mapping: Record<string, string | Buffer> = {
                        id: item.id,
                        v: Buffer.from(blob),
                        userId: this.getValkeyId(userId),
                        dim: item.dim.toString(),
                        metadata: item.metadata ? JSON.stringify(item.metadata) : "",
                    };
                    pipe.hset(key, mapping);
                    pipe.sadd(`idx:id_sectors:${item.id}`, item.sector);
                }
                await pipe.exec();
            },
            { retries: 2, delay: 200 },
        );
    }

    async deleteVector(
        id: string,
        sector: string,
        userId?: string | null,
    ): Promise<void> {
        const key = this.getKey(id, sector);
        if (userId !== undefined) {
            const client = getRedisClient();
            const data = await client.hget(key, "userId");
            const normalizedOwner = normalizeUserId(data);
            const normalizedTarget = normalizeUserId(userId);
            if (normalizedOwner !== normalizedTarget) return;
        }
        const client = getRedisClient();
        const pipe = client.pipeline();
        pipe.del(key);
        pipe.srem(`idx:id_sectors:${id}`, sector);
        await pipe.exec();
    }

    async deleteVectors(ids: string[], userId?: string | null): Promise<void> {
        // Optimized deletion using reverse index
        const client = getRedisClient();

        // Chunking concurrency to avoid overwhelming Redis connections
        const BATCH_SIZE = 50;
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
            const chunk = ids.slice(i, i + BATCH_SIZE);
            const pending = chunk.map(async (id) => {
                const reverseKey = `idx:id_sectors:${id}`;
                const sectors = await client.smembers(reverseKey);

                if (!sectors || sectors.length === 0) {
                    // Try scan fallback if empty (legacy)
                    await this.scanDeleteFallback(id, userId);
                    return;
                }

                const keysToDelete: string[] = [];
                const sectorsToRemove: string[] = [];

                for (const sector of sectors) {
                    const key = `vec:${sector}:${id}`;
                    if (userId !== undefined) {
                        const owner = await client.hget(key, "userId");
                        const normalizedOwner = normalizeUserId(owner);
                        const normalizedTarget = normalizeUserId(userId);
                        if (normalizedOwner === normalizedTarget) {
                            keysToDelete.push(key);
                            sectorsToRemove.push(sector);
                        }
                    } else {
                        keysToDelete.push(key);
                        sectorsToRemove.push(sector);
                    }
                }

                if (keysToDelete.length > 0) {
                    const pipe = client.pipeline();
                    pipe.del(...keysToDelete);
                    if (sectorsToRemove.length === sectors.length && !userId) {
                        pipe.del(reverseKey); // All sectors gone
                    } else {
                        if (!userId) pipe.del(reverseKey);
                        else if (sectorsToRemove.length > 0) {
                            pipe.srem(reverseKey, ...sectorsToRemove);
                        }
                    }
                    await pipe.exec();
                }
            });

            await Promise.all(pending);
        }
    }

    private async scanDeleteFallback(
        id: string,
        userId?: string | null,
    ): Promise<void> {
        let cursor = "0";
        const client = getRedisClient();
        do {
            const res = await client.scan(
                cursor,
                "MATCH",
                `vec:*:${id}`,
                "COUNT",
                100,
            );
            cursor = res[0];
            const keys = res[1];
            if (keys.length) {
                if (userId !== undefined) {
                    const normalizedTarget = normalizeUserId(userId);
                    for (const key of keys) {
                        const data = await client.hget(key, "userId");
                        if (normalizeUserId(data) === normalizedTarget)
                            await client.del(key);
                    }
                } else {
                    await client.del(...keys);
                }
            }
        } while (cursor !== "0");
    }

    async searchSimilar(
        sector: string,
        queryVec: number[],
        topK: number,
        userId?: string | null,
        _filter?: { metadata?: Record<string, unknown> },
    ): Promise<Array<{ id: string; score: number }>> {
        const indexName = `idx:${sector}`;
        const blob = vectorToUint8Array(queryVec);

        const uid = normalizeUserId(userId);
        let query = "";
        if (uid === undefined) {
            query = "(*)"; // Any: access everything
        } else {
            query = `(@userId:{${this.getValkeyId(userId)}})`; // Specific user or anonymous
        }

        if (_filter?.metadata) {
            // Standardize metadata filtering in Valkey (via loose string matching in HASH)
            // Note: For precise filtering, we should migrate to JSON backends or use TAG fields.
            // For now, we enhance the loose matching.
            for (const [key, val] of Object.entries(_filter.metadata)) {
                if (val !== undefined) {
                    // Escape special characters in val for RediSearch query syntax
                    const safeVal = String(val).replace(/([@:!{}()|~+\-*?])/g, "\\$1");
                    query += ` (@metadata:*${key}*${safeVal}*)`;
                }
            }
        }

        query += ` *=>[KNN ${topK} @v $blob AS score]`;

        try {
            const res = await retry(
                async () => {
                    return (await getRedisClient().call(
                        "FT.SEARCH",
                        indexName,
                        query,
                        "PARAMS",
                        "2",
                        "blob",
                        Buffer.from(blob),
                        "SORTBY",
                        "score",
                        "ASC",
                        "DIALECT",
                        "2",
                        "LIMIT",
                        "0",
                        topK.toString(),
                    )) as unknown as [number, ...any[]];
                },
                {
                    retries: 2,
                    delay: 200,
                    onRetry: (e: unknown, i) =>
                        logger.warn(
                            `[VALKEY] Search retry ${i}/2: ${(e as Error).message}`,
                            { error: e },
                        ),
                },
            );

            if (!res || res[0] === 0) return [];
            const results: Array<{ id: string; score: number }> = [];
            for (let i = 1; i < res.length; i += 2) {
                const fields = res[i + 1];
                let id = "";
                let score = 0;
                for (let j = 0; j < fields.length; j += 2) {
                    if (fields[j] === "id") id = fields[j + 1];
                    if (fields[j] === "score")
                        score = parseFloat(fields[j + 1]);
                }
                results.push({ id, score: 1 - score }); // Convert distance to similarity
            }
            return results;
        } catch (e) {
            logger.error(
                `[VALKEY] Search failed for ${indexName} after retries:`,
                { error: e },
            );
            return [];
        }
    }

    async getVector(
        id: string,
        sector: string,
        userId?: string | null,
    ): Promise<{ vector: number[]; dim: number } | null> {
        const key = this.getKey(id, sector);
        const res = await getRedisClient().hgetall(key);
        if (!res || !res.v) return null;
        if (userId && res.userId !== userId) return null;
        return {
            vector: bufferToVector(res.v as unknown as Buffer),
            dim: parseInt(res.dim),
        };
    }

    async getVectorsById(
        id: string,
        userId?: string | null,
    ): Promise<Array<{ sector: string; vector: number[]; dim: number }>> {
        const rows = await this.getVectorsByIds([id], userId);
        return rows.map((r) => ({
            sector: r.sector,
            vector: r.vector,
            dim: r.dim,
        }));
    }

    async getVectorsByIds(
        ids: string[],
        userId?: string | null,
    ): Promise<
        Array<{ id: string; sector: string; vector: number[]; dim: number }>
    > {
        const results: Array<{
            id: string;
            sector: string;
            vector: number[];
            dim: number;
        }> = [];

        await Promise.all(
            ids.map(async (id) => {
                const reverseKey = `idx:id_sectors:${id}`;
                const client = getRedisClient();
                const sectors = await client.smembers(reverseKey);

                if (!sectors.length) {
                    // Fallback to scan if not indexed
                    await this.scanFetchFallback(id, userId, results);
                    return;
                }

                for (const sector of sectors) {
                    const key = `vec:${sector}:${id}`;
                    const data = await client.hgetall(key);
                    if (data && data.v && (!userId || data.userId === userId)) {
                        results.push({
                            id,
                            sector,
                            vector: bufferToVector(data.v as unknown as Buffer),
                            dim: parseInt(data.dim || "0"),
                        });
                    }
                }
            }),
        );

        return results;
    }

    private async scanFetchFallback(
        id: string,
        userId: string | null | undefined,
        results: Array<{
            id: string;
            sector: string;
            vector: number[];
            dim: number;
        }>,
    ) {
        let cursor = "0";
        const client = getRedisClient();
        do {
            const res = await client.scan(
                cursor,
                "MATCH",
                `vec:*:${id}`,
                "COUNT",
                100,
            );
            cursor = res[0];
            const keys = res[1];
            for (const key of keys) {
                const data = await client.hgetall(key);
                if (data && data.v && (!userId || data.userId === userId)) {
                    const parts = key.split(":");
                    const sector = parts[1];
                    results.push({
                        id,
                        sector,
                        vector: bufferToVector(data.v as unknown as Buffer),
                        dim: parseInt(data.dim || "0"),
                    });
                }
            }
        } while (cursor !== "0");
    }

    async getVectorsBySector(
        sector: string,
        userId?: string | null,
        limit: number = 1000,
        offset: number = 0,
    ): Promise<Array<{ id: string; vector: number[]; dim: number }>> {
        const indexName = `idx:${sector}`;
        const uid = normalizeUserId(userId);

        // Strategy A: Use RediSearch (Efficient)
        try {
            const query = uid !== undefined
                ? `(@userId:{${this.getValkeyId(userId)}})`
                : "*";

            const res = (await getRedisClient().call(
                "FT.SEARCH",
                indexName,
                query,
                "LIMIT",
                offset.toString(),
                limit.toString(),
                "RETURN", "3", "id", "v", "dim"
            )) as unknown as [number, ...any[]];

            if (!res || res[0] === 0) return [];

            const results: Array<{ id: string; vector: number[]; dim: number }> = [];
            for (let i = 1; i < res.length; i += 2) {
                const fields = res[i + 1];
                // Parse generic array response from Redis
                let id = "";
                let v: Buffer | null = null;
                let dim = 0;
                for (let j = 0; j < fields.length; j += 2) {
                    if (fields[j] === "id") id = fields[j + 1];
                    else if (fields[j] === "v") v = fields[j + 1];
                    else if (fields[j] === "dim") dim = parseInt(fields[j + 1]);
                }

                // Handle binary data correctly (ioredis returns Buffer for Buffer args usually)
                // If v is string (lazy dependency), bufferToVector handles it? 
                // bufferToVector expects Buffer.
                if (id && v) {
                    // Ensure v is Buffer
                    const buf = Buffer.isBuffer(v) ? v : Buffer.from(v as any);
                    results.push({
                        id,
                        vector: bufferToVector(buf),
                        dim: dim || 0
                    });
                }
            }
            return results;

        } catch (e: any) {
            // Strategy B: Fallback to SCAN (Slow, O(N))
            // Only if index missing or error
            if (!e.message?.includes("Unknown index")) {
                logger.warn(`[VALKEY] FT.SEARCH failed for ${sector}, falling back to SCAN.`, { error: e });
            }

            const results: Array<{ id: string; vector: number[]; dim: number }> = [];
            let cursor = "0";
            const prefix = `vec:${sector}:`;
            const client = getRedisClient();
            let skipped = 0;

            do {
                const res = await client.scan(
                    cursor,
                    "MATCH",
                    `${prefix}*`,
                    "COUNT",
                    100, // Batch size
                );
                cursor = res[0];
                const keys = res[1];

                // Pipeline fetching values
                if (keys.length > 0) {
                    const pipe = client.pipeline();
                    for (const k of keys) pipe.hgetall(k);
                    const items = await pipe.exec();

                    if (items) {
                        for (const itemRes of items) {
                            const [err, data] = itemRes as [Error | null, any];
                            if (!err && data && data.v && (!userId || data.userId === uid)) {
                                if (skipped < offset) {
                                    skipped++;
                                    continue;
                                }
                                if (results.length >= limit) {
                                    return results;
                                }

                                results.push({
                                    id: data.id,
                                    vector: bufferToVector(data.v as unknown as Buffer),
                                    dim: parseInt(data.dim),
                                });
                            }
                        }
                    }
                }
                if (results.length >= limit) break; // Optimization
            } while (cursor !== "0");

            return results;
        }
    }

    async deleteVectorsByUser(userId: string): Promise<void> {
        const uid = normalizeUserId(userId);
        if (!uid) return;

        const client = getRedisClient();

        // 1. Try to find all indices
        let indices: string[] = [];
        try {
            const list = (await client.call("FT._LIST")) as string[];
            if (Array.isArray(list)) indices = list;
        } catch (e) {
            // RediSearch not available
        }

        const keysToDelete = new Set<string>();
        const idsToClean = new Set<string>();

        // 2. Search Indices
        if (indices.length > 0) {
            for (const index of indices) {
                if (!index.startsWith("idx:")) continue;
                try {
                    // Fetch IDs for this user
                    const searchRes = (await client.call(
                        "FT.SEARCH",
                        index,
                        `@userId:{${uid}}`,
                        "RETURN",
                        "1",
                        "id",
                        "LIMIT",
                        "0",
                        "10000",
                    )) as unknown as [number, ...any[]];

                    if (searchRes && searchRes[0] > 0) {
                        for (let i = 1; i < searchRes.length; i += 2) {
                            const key = searchRes[i] as string;
                            keysToDelete.add(key);
                            const parts = key.split(":");
                            if (parts.length >= 3) idsToClean.add(parts[2]);
                        }
                    }
                } catch (e) {
                    logger.warn(
                        `[Valkey] Error during wipe search in ${index}`,
                        { error: e },
                    );
                }
            }
        }

        // 3. Fallback Scan if indices empty
        if (indices.length === 0) {
            let cursor = "0";
            do {
                const res = await client.scan(
                    cursor,
                    "MATCH",
                    "vec:*:*",
                    "COUNT",
                    1000,
                );
                cursor = res[0];
                const keys = res[1];

                if (keys.length > 0) {
                    const pipe = client.pipeline();
                    for (const k of keys) pipe.hget(k, "userId");
                    const owners = await pipe.exec();

                    if (owners) {
                        owners.forEach((o, idx) => {
                            const [err, val] = o as [Error | null, string | null];
                            if (!err && normalizeUserId(val) === uid) {
                                const key = keys[idx];
                                keysToDelete.add(key);
                                const parts = key.split(":");
                                if (parts.length >= 3) idsToClean.add(parts[2]);
                            }
                        });
                    }
                }
            } while (cursor !== "0");
        }

        // 4. Delete
        if (keysToDelete.size > 0) {
            const pipe = client.pipeline();
            for (const key of keysToDelete) pipe.del(key);
            for (const id of idsToClean) pipe.del(`idx:id_sectors:${id}`);
            await pipe.exec();
        }
    }

    async getAllVectorIds(userId?: string | null): Promise<Set<string>> {
        const ids = new Set<string>();
        for await (const id of this.iterateVectorIds(userId)) {
            ids.add(id);
        }
        return ids;
    }

    async *iterateVectorIds(userId?: string | null): AsyncIterable<string> {
        let cursor = "0";
        const client = getRedisClient();
        const normalizedTarget = normalizeUserId(userId);

        do {
            const res = await client.scan(
                cursor,
                "MATCH",
                "idx:id_sectors:*",
                "COUNT",
                100,
            );
            cursor = res[0];
            const keys = res[1];

            if (keys.length === 0) continue;

            const chunkIds: string[] = [];
            for (const k of keys) {
                const id = k.split(":").pop();
                if (id) chunkIds.push(id);
            }

            if (chunkIds.length === 0) continue;

            if (normalizedTarget === undefined) {
                // Global access: just yield IDs
                for (const id of chunkIds) yield id;
            } else {
                // Pipeline ownership checks
                const pipe = client.pipeline();
                // Get sectors for each ID to find a representative key
                for (const k of keys) {
                    pipe.smembers(k);
                }

                const results = await pipe.exec();
                if (results) {
                    // Second pass pipeline for HGET matches
                    const verifyPipe = client.pipeline();
                    const verifyMap: number[] = []; // Map pipe index to chunk index

                    for (let i = 0; i < results.length; i++) {
                        const [err, sectors] = results[i] as [Error | null, string[]];
                        if (!err && sectors && sectors.length > 0) {
                            // Check first sector
                            const key = `vec:${sectors[0]}:${chunkIds[i]}`;
                            verifyPipe.hget(key, "userId");
                            verifyMap.push(i);
                        }
                    }

                    if (verifyMap.length > 0) {
                        const verifyResults = await verifyPipe.exec();
                        if (verifyResults) {
                            for (let j = 0; j < verifyResults.length; j++) {
                                const [vErr, owner] = verifyResults[j] as [Error | null, string | null];
                                if (!vErr && normalizeUserId(owner) === normalizedTarget) {
                                    yield chunkIds[verifyMap[j]];
                                }
                            }
                        }
                    }
                }
            }
        } while (cursor !== "0");
    }

    async cleanupOrphanedVectors(_userId?: string | null): Promise<{ deleted: number }> {
        // Valkey implementation of orphaned cleanup is complex as it requires cross-checking with SQL DB.
        // For now, we rely on application-level consistency (deleteMemory calling deleteVectors).
        return { deleted: 0 };
    }

    async disconnect(): Promise<void> {
        // Shared client is managed globally, no-op here or delegates to global close if we wanted
        // usually verify if we are the process owner? For now, we leave it open.
    }
}
