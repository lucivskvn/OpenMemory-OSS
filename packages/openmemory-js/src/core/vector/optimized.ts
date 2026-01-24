/**
 * @file Optimized Vector Store Implementation
 * High-performance vector store with SIMD-like optimizations and advanced caching
 */

import { normalizeUserId } from "../../utils";
import { logger } from "../../utils/logger";
import {
    bufferToFloat32Array,
    bufferToVector,
    vectorToUint8Array,
} from "../../utils/vectors";
import {
    cosineSimilarityOptimized,
    batchCosineSimilarity,
    VectorOperationStats
} from "../../utils/vectorsOptimized";
import { env } from "../cfg";
import { applySqlUser, SqlValue } from "../dbUtils";
import { VectorStore } from "../vectorStore";

interface DbOps {
    runAsync: (sql: string, params?: SqlValue[]) => Promise<number>;
    getAsync: <T = unknown>(sql: string, params?: SqlValue[]) => Promise<T | undefined>;
    allAsync: <T = unknown>(sql: string, params?: SqlValue[]) => Promise<T[]>;
    transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
    iterateAsync: <T = unknown>(sql: string, params?: SqlValue[]) => AsyncIterable<T>;
}

interface VectorRow {
    id: string;
    sector: string;
    v: Uint8Array;
    dim: number;
    score?: number;
}

interface CachedVector {
    id: string;
    sector: string;
    vector: Float32Array;
    dim: number;
    userId: string | null;
    metadata?: Record<string, unknown>;
    timestamp: number;
}

/**
 * Advanced LRU cache with memory management for vectors
 */
class OptimizedVectorCache {
    private cache = new Map<string, CachedVector[]>();
    private accessOrder = new Map<string, number>();
    private currentMemory = 0;
    private accessCounter = 0;
    
    constructor(
        private maxSize: number = 1000,
        private maxMemoryMB: number = 100
    ) {}
    
    private estimateMemoryUsage(vectors: CachedVector[]): number {
        return vectors.reduce((sum, v) => sum + v.vector.byteLength + 200, 0); // 200 bytes overhead per vector
    }
    
    private evictLRU(): void {
        if (this.cache.size === 0) return;
        
        // Find least recently used entry
        let oldestKey = '';
        let oldestAccess = Infinity;
        
        for (const [key, access] of this.accessOrder.entries()) {
            if (access < oldestAccess) {
                oldestAccess = access;
                oldestKey = key;
            }
        }
        
        if (oldestKey) {
            const vectors = this.cache.get(oldestKey);
            if (vectors) {
                this.currentMemory -= this.estimateMemoryUsage(vectors);
            }
            this.cache.delete(oldestKey);
            this.accessOrder.delete(oldestKey);
        }
    }
    
    get(id: string): CachedVector[] | undefined {
        const vectors = this.cache.get(id);
        if (vectors) {
            this.accessOrder.set(id, ++this.accessCounter);
            return vectors;
        }
        return undefined;
    }
    
    set(id: string, vectors: CachedVector[]): void {
        const memoryUsage = this.estimateMemoryUsage(vectors);
        const maxMemoryBytes = this.maxMemoryMB * 1024 * 1024;
        
        // Evict if necessary
        while ((this.cache.size >= this.maxSize || 
                this.currentMemory + memoryUsage > maxMemoryBytes) && 
               this.cache.size > 0) {
            this.evictLRU();
        }
        
        // Don't cache if single item is too large
        if (memoryUsage > maxMemoryBytes * 0.1) {
            logger.warn(`[VectorCache] Skipping cache for large vector set: ${memoryUsage} bytes`);
            return;
        }
        
        this.cache.set(id, vectors);
        this.accessOrder.set(id, ++this.accessCounter);
        this.currentMemory += memoryUsage;
    }
    
    delete(id: string): void {
        const vectors = this.cache.get(id);
        if (vectors) {
            this.currentMemory -= this.estimateMemoryUsage(vectors);
        }
        this.cache.delete(id);
        this.accessOrder.delete(id);
    }
    
    clear(): void {
        this.cache.clear();
        this.accessOrder.clear();
        this.currentMemory = 0;
        this.accessCounter = 0;
    }
    
    getStats(): {
        size: number;
        memoryMB: number;
        hitRate: number;
    } {
        return {
            size: this.cache.size,
            memoryMB: this.currentMemory / (1024 * 1024),
            hitRate: 0 // Would need to track hits/misses for this
        };
    }
}

/**
 * Optimized Vector Store with advanced caching and SIMD-like operations
 */
export class OptimizedVectorStore implements VectorStore {
    private table: string;
    private cache: OptimizedVectorCache;
    private stats = VectorOperationStats.getInstance();
    
    // Performance monitoring
    private performanceMetrics = {
        searchCount: 0,
        totalSearchTime: 0,
        cacheHits: 0,
        cacheMisses: 0
    };

    constructor(
        private db: DbOps,
        tableName: string = "vectors",
        cacheSize: number = 1000,
        cacheMemoryMB: number = 100
    ) {
        this.table = tableName;
        this.cache = new OptimizedVectorCache(cacheSize, cacheMemoryMB);
    }

    async storeVector(
        id: string,
        sector: string,
        vector: number[],
        dim: number,
        userId?: string | null,
        metadata?: Record<string, unknown>,
    ): Promise<void> {
        if (env.verbose) {
            logger.debug(`[OptimizedVector] Storing ID: ${id}, Sector: ${sector}, Dim: ${dim}`);
        }

        if (!vector || vector.length !== dim) {
            throw new Error(`[OptimizedVector] Dimension Mismatch: Expected ${dim}, got ${vector?.length}`);
        }

        const isPg = env.vectorBackend === "postgres" || env.metadataBackend === "postgres";
        const v = isPg ? `[${vector.join(",")}]` : vectorToUint8Array(vector);
        const uid = normalizeUserId(userId);
        const metaStr = metadata ? JSON.stringify(metadata) : null;
        const placeholders = isPg ? "$1, $2, $3, $4, $5, $6" : "?, ?, ?, ?, ?, ?";
        
        const sql = `insert into ${this.table}(id,sector,user_id,v,dim,metadata) values(${placeholders}) on conflict(id,sector) do update set user_id=excluded.user_id,v=excluded.v,dim=excluded.dim,metadata=excluded.metadata`;
        await this.db.runAsync(sql, [id, sector, uid ?? null, v, dim, metaStr]);

        // Invalidate cache
        this.cache.delete(id);
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
        
        const startTime = performance.now();
        const uid = normalizeUserId(userId);
        const isPg = env.vectorBackend === "postgres" || env.metadataBackend === "postgres";

        if (isPg) {
            // Optimized Postgres batch insert with larger batch sizes
            const BATCH_SIZE = 2000; // Increased batch size for better performance
            
            const runPgBatch = async () => {
                for (let i = 0; i < items.length; i += BATCH_SIZE) {
                    const chunk = items.slice(i, i + BATCH_SIZE);
                    const params: SqlValue[] = [];
                    const rows: string[] = [];
                    let paramIndex = 1;
                    
                    for (const item of chunk) {
                        if (item.vector.length !== item.dim) {
                            logger.warn(`[OptimizedVector] Batch Dim Mismatch for ID ${item.id}: Expected ${item.dim}, got ${item.vector.length}. Skipping.`);
                            continue;
                        }
                        
                        const vectorString = `[${item.vector.join(",")}]`;
                        const metaStr = item.metadata ? JSON.stringify(item.metadata) : null;
                        
                        params.push(item.id, item.sector, uid, vectorString, item.dim, metaStr);
                        rows.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5})`);
                        paramIndex += 6;
                    }
                    
                    if (rows.length === 0) continue;
                    
                    const sql = `insert into ${this.table}(id,sector,user_id,v,dim,metadata) values ${rows.join(",")} on conflict(id,sector) do update set user_id=excluded.user_id,v=excluded.v,dim=excluded.dim,metadata=excluded.metadata`;
                    await this.db.runAsync(sql, params);
                }
            };

            if (this.db.transaction) await this.db.transaction(runPgBatch);
            else await runPgBatch();
        } else {
            // SQLite optimized batch
            const runBatch = async () => {
                // Prepare statement once for better performance
                const sql = `insert into ${this.table}(id,sector,user_id,v,dim,metadata) values(?,?,?,?,?,?) on conflict(id,sector) do update set user_id=excluded.user_id,v=excluded.v,dim=excluded.dim,metadata=excluded.metadata`;
                
                for (const item of items) {
                    if (item.vector.length !== item.dim) {
                        logger.warn(`[OptimizedVector] Batch Dim Mismatch for ID ${item.id}: Expected ${item.dim}, got ${item.vector.length}. Skipping.`);
                        continue;
                    }
                    
                    const v = vectorToUint8Array(item.vector);
                    const metaStr = item.metadata ? JSON.stringify(item.metadata) : null;
                    await this.db.runAsync(sql, [item.id, item.sector, uid ?? null, v, item.dim, metaStr]);
                }
            };
            
            if (this.db.transaction) await this.db.transaction(runBatch);
            else await runBatch();
        }

        // Invalidate cache for all items
        for (const item of items) {
            this.cache.delete(item.id);
        }
        
        const batchTime = performance.now() - startTime;
        this.stats.recordBatchOperation(batchTime);
        
        if (env.verbose) {
            logger.debug(`[OptimizedVector] Stored ${items.length} vectors in ${batchTime.toFixed(2)}ms`);
        }
    }

    async deleteVector(id: string, sector: string, userId?: string | null): Promise<void> {
        const uid = normalizeUserId(userId);
        const { sql, params } = applySqlUser(
            `delete from ${this.table} where id=? and sector=?`,
            [id, sector],
            uid,
        );
        await this.db.runAsync(sql, params);
        this.cache.delete(id);
    }

    async deleteVectors(ids: string[], userId?: string | null): Promise<void> {
        if (ids.length === 0) return;
        
        const uid = normalizeUserId(userId);
        const BATCH_SIZE = 500; // Optimized batch size
        
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
            const chunk = ids.slice(i, i + BATCH_SIZE);
            const placeholders = chunk.map(() => "?").join(",");
            const { sql, params } = applySqlUser(
                `delete from ${this.table} where id IN (${placeholders})`,
                [...chunk],
                uid,
            );
            await this.db.runAsync(sql, params);
        }
        
        for (const id of ids) this.cache.delete(id);
    }

    async searchSimilar(
        sector: string,
        queryVec: number[],
        topK: number,
        userId?: string | null,
        filter?: { metadata?: Record<string, unknown> },
    ): Promise<Array<{ id: string; score: number }>> {
        const startTime = performance.now();
        this.performanceMetrics.searchCount++;
        
        const uid = normalizeUserId(userId);
        let whereClause = "";
        const extraParams: SqlValue[] = [];

        if (filter?.metadata) {
            const isPg = env.vectorBackend === "postgres";
            if (isPg) {
                whereClause += ` AND metadata @> ? `;
                extraParams.push(JSON.stringify(filter.metadata));
            } else {
                for (const [key, val] of Object.entries(filter.metadata)) {
                    if (val !== undefined) {
                        whereClause += ` AND json_extract(metadata, '$.' || ?) = ? `;
                        extraParams.push(key, val as SqlValue);
                    }
                }
            }
        }

        // Try pgvector first if available
        if (env.vectorBackend === "postgres") {
            const vectorString = `[${queryVec.join(",")}]`;
            let sql = `
                SELECT id, 1 - (v <=> $1) as score 
                FROM ${this.table}
                WHERE sector = $2
                ${whereClause}
            `;
            let params: SqlValue[] = [vectorString, sector, ...extraParams];

            if (uid === null) {
                sql += " AND user_id IS NULL";
            } else if (uid !== undefined) {
                sql += " AND user_id = $" + (params.length + 1);
                params.push(uid);
            }

            sql += ` ORDER BY v <=> $1 ASC LIMIT ${topK}`;

            try {
                const rows = await this.db.allAsync<{ id: string; score: number }>(sql, params);
                const searchTime = performance.now() - startTime;
                this.performanceMetrics.totalSearchTime += searchTime;
                this.stats.recordSimilarity(searchTime);
                
                return rows.map((r) => ({ id: r.id, score: r.score }));
            } catch (error: unknown) {
                logger.warn("[OptimizedVector] pgvector search failed, using optimized JS fallback.", { error });
            }
        }

        // Optimized JS fallback with batch processing
        let sql = `select id, v, dim from ${this.table} where sector=?`;
        const params: SqlValue[] = [sector];

        if (whereClause) {
            sql += whereClause;
            params.push(...extraParams);
        }

        if (uid !== undefined) {
            if (uid === null) sql += ` and user_id IS NULL`;
            else {
                sql += ` and user_id=?`;
                params.push(uid);
            }
        }

        // Collect vectors for batch processing
        const vectors: Array<{ id: string; vector: Float32Array }> = [];
        const queryVecF32 = new Float32Array(queryVec);
        
        const iterator = this.db.iterateAsync<VectorRow>(sql, params);
        for await (const row of iterator) {
            if (!row.v) continue;
            try {
                const vec = bufferToFloat32Array(row.v);
                if (vec.length !== queryVecF32.length) continue;
                vectors.push({ id: row.id, vector: vec });
            } catch (e) {
                logger.debug("[OptimizedVector] Failed to parse vector in search fallback", { 
                    id: row.id, 
                    error: e 
                });
            }
        }

        // Use optimized batch similarity computation
        const vectorArrays = vectors.map(v => v.vector);
        const similarities = batchCosineSimilarity(queryVecF32, vectorArrays, topK);
        
        const results = similarities.map(sim => ({
            id: vectors[sim.index].id,
            score: sim.score
        }));

        const searchTime = performance.now() - startTime;
        this.performanceMetrics.totalSearchTime += searchTime;
        this.stats.recordSimilarity(searchTime);

        if (env.verbose) {
            logger.debug(`[OptimizedVector] Search completed in ${searchTime.toFixed(2)}ms, found ${results.length} results`);
        }

        return results;
    }

    async getVector(
        id: string,
        sector: string,
        userId?: string | null,
    ): Promise<{ vector: number[]; dim: number; metadata?: Record<string, unknown> } | null> {
        const rows = await this.getVectorsByIds([id], userId);
        const match = rows.find(r => r.sector === sector);
        return match ? { 
            vector: match.vector, 
            dim: match.dim, 
            metadata: match.metadata 
        } : null;
    }

    async getVectorsById(
        id: string,
        userId?: string | null,
    ): Promise<Array<{ sector: string; vector: number[]; dim: number; metadata?: Record<string, unknown> }>> {
        const rows = await this.getVectorsByIds([id], userId);
        return rows.map((r) => ({
            sector: r.sector,
            vector: r.vector,
            dim: r.dim,
            metadata: r.metadata
        }));
    }

    async getVectorsByIds(
        ids: string[],
        userId?: string | null,
    ): Promise<Array<{ 
        id: string; 
        sector: string; 
        vector: number[]; 
        dim: number; 
        metadata?: Record<string, unknown> 
    }>> {
        if (ids.length === 0) return [];
        
        const uid = normalizeUserId(userId);
        const results: Array<{ 
            id: string; 
            sector: string; 
            vector: number[]; 
            dim: number; 
            metadata?: Record<string, unknown> 
        }> = [];
        const missingIds: string[] = [];

        // Check cache first
        for (const id of ids) {
            const cached = this.cache.get(id);
            if (cached) {
                this.performanceMetrics.cacheHits++;
                for (const c of cached) {
                    if (uid === undefined || c.userId === uid) {
                        results.push({
                            id: c.id,
                            sector: c.sector,
                            vector: Array.from(c.vector),
                            dim: c.dim,
                            metadata: c.metadata
                        });
                    }
                }
            } else {
                this.performanceMetrics.cacheMisses++;
                missingIds.push(id);
            }
        }

        if (missingIds.length === 0) return results;

        // Fetch missing vectors with optimized batch size
        const FETCH_BATCH_SIZE = 100;
        for (let i = 0; i < missingIds.length; i += FETCH_BATCH_SIZE) {
            const batch = missingIds.slice(i, i + FETCH_BATCH_SIZE);
            const placeholders = batch.map(() => "?").join(",");
            const { sql, params } = applySqlUser(
                `select id, sector, user_id as userId, v, dim, metadata from ${this.table} where id IN (${placeholders})`,
                [...batch],
                uid,
            );

            const rows = await this.db.allAsync<VectorRow & { userId?: string, metadata?: string }>(sql, params);
            
            // Group by ID for caching
            const byId = new Map<string, CachedVector[]>();

            for (const r of rows) {
                try {
                    const vector = bufferToFloat32Array(r.v);
                    const metadata = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
                    
                    const cachedVector: CachedVector = {
                        id: r.id,
                        sector: r.sector,
                        vector,
                        dim: r.dim,
                        userId: (r as any).userId ?? (r as any).user_id ?? null,
                        metadata,
                        timestamp: Date.now()
                    };

                    results.push({
                        id: cachedVector.id,
                        sector: cachedVector.sector,
                        vector: Array.from(cachedVector.vector),
                        dim: cachedVector.dim,
                        metadata: cachedVector.metadata
                    });

                    if (!byId.has(r.id)) byId.set(r.id, []);
                    byId.get(r.id)!.push(cachedVector);

                } catch (e) {
                    logger.debug("[OptimizedVector] Failed to parse vector in getVectorsByIds", { 
                        id: r.id, 
                        error: e 
                    });
                }
            }

            // Update cache
            for (const [id, vectors] of byId.entries()) {
                this.cache.set(id, vectors);
            }
        }

        return results;
    }

    async getVectorsBySector(
        sector: string,
        userId?: string | null,
        limit: number = 1000,
        offset: number = 0,
    ): Promise<Array<{ id: string; vector: number[]; dim: number }>> {
        const uid = normalizeUserId(userId);
        const { sql: userSql, params: userParams } = applySqlUser(
            `select id, v, dim from ${this.table} where sector=?`,
            [sector],
            uid,
        );

        const sql = `${userSql} LIMIT ? OFFSET ?`;
        const params = [...userParams, limit, offset];

        const rows = await this.db.allAsync<VectorRow>(sql, params);
        return rows.map((r) => ({
            id: r.id,
            vector: bufferToVector(r.v),
            dim: r.dim,
        }));
    }

    async deleteVectorsByUser(userId: string): Promise<void> {
        const uid = normalizeUserId(userId);
        if (!uid) return;

        const isPg = env.vectorBackend === "postgres" || env.metadataBackend === "postgres";

        // Get IDs for cache invalidation
        let ids: string[] = [];
        try {
            const idSql = isPg
                ? `select distinct id from ${this.table} where user_id = $1`
                : `select distinct id from ${this.table} where user_id = ?`;
            const rows = await this.db.allAsync<{ id: string }>(idSql, [uid]);
            ids = rows.map(r => r.id);
        } catch (e) {
            logger.warn(`[OptimizedVector] Failed to fetch IDs for cache invalidation during user wipe`, { error: e });
        }

        const sql = isPg 
            ? `delete from ${this.table} where user_id = $1`
            : `delete from ${this.table} where user_id = ?`;
        await this.db.runAsync(sql, [uid]);

        // Invalidate cache
        for (const id of ids) {
            this.cache.delete(id);
        }
    }

    async getAllVectorIds(userId?: string | null): Promise<Set<string>> {
        const uid = normalizeUserId(userId);
        const { sql, params } = applySqlUser(
            `select distinct id from ${this.table}`,
            [],
            uid,
        );
        const rows = await this.db.allAsync<{ id: string }>(sql, params);
        return new Set(rows.map((r) => r.id));
    }

    async *iterateVectorIds(userId?: string | null): AsyncIterable<string> {
        const uid = normalizeUserId(userId);
        const { sql, params } = applySqlUser(
            `select distinct id from ${this.table}`,
            [],
            uid,
        );
        
        const iterator = this.db.iterateAsync<{ id: string }>(sql, params);
        for await (const row of iterator) {
            yield row.id;
        }
    }

    async cleanupOrphanedVectors(userId?: string | null): Promise<{ deleted: number }> {
        const uid = normalizeUserId(userId);
        const sql = `
            delete from ${this.table} 
            where (select count(*) from memories where memories.id = ${this.table}.id) = 0
        `;
        const { sql: finalizedSql, params } = applySqlUser(sql, [], uid);

        const deleted = await this.db.runAsync(finalizedSql, params);
        
        // Clear cache since we don't know which vectors were deleted
        this.cache.clear();
        
        return { deleted };
    }

    /**
     * Get performance metrics for monitoring
     */
    getPerformanceMetrics(): {
        searchCount: number;
        averageSearchTime: number;
        cacheHitRate: number;
        cacheStats: ReturnType<OptimizedVectorCache['getStats']>;
        vectorStats: ReturnType<VectorOperationStats['getStats']>;
    } {
        const totalRequests = this.performanceMetrics.cacheHits + this.performanceMetrics.cacheMisses;
        
        return {
            searchCount: this.performanceMetrics.searchCount,
            averageSearchTime: this.performanceMetrics.searchCount > 0 
                ? this.performanceMetrics.totalSearchTime / this.performanceMetrics.searchCount 
                : 0,
            cacheHitRate: totalRequests > 0 
                ? this.performanceMetrics.cacheHits / totalRequests 
                : 0,
            cacheStats: this.cache.getStats(),
            vectorStats: this.stats.getStats()
        };
    }

    /**
     * Reset performance metrics
     */
    resetMetrics(): void {
        this.performanceMetrics = {
            searchCount: 0,
            totalSearchTime: 0,
            cacheHits: 0,
            cacheMisses: 0
        };
        this.stats.reset();
    }

    /**
     * Warm up the cache with frequently accessed vectors
     */
    async warmupCache(vectorIds: string[], userId?: string | null): Promise<void> {
        if (vectorIds.length === 0) return;
        
        logger.info(`[OptimizedVector] Warming up cache with ${vectorIds.length} vectors`);
        
        // Batch load vectors into cache
        const WARMUP_BATCH_SIZE = 50;
        for (let i = 0; i < vectorIds.length; i += WARMUP_BATCH_SIZE) {
            const batch = vectorIds.slice(i, i + WARMUP_BATCH_SIZE);
            await this.getVectorsByIds(batch, userId);
        }
        
        logger.info(`[OptimizedVector] Cache warmup completed`);
    }
}