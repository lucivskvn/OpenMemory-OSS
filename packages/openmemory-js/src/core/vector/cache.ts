/**
 * @file Vector Cache System
 * LRU Cache specifically designed for storing vector data efficiently.
 * Helps prevent memory leaks by enforcing strict size limits.
 */
import { env } from "../cfg";
import { logger } from "../../utils/logger";

export interface CachedVector {
    id: string;
    sector: string;
    vector: Float32Array;
    dim: number;
    userId: string | null;
}

export class VectorCache {
    private cache = new Map<string, CachedVector[]>(); // ID -> Vector(s)
    private _currentSize = 0;
    private _maxSize: number;

    public hits = 0;
    public misses = 0;
    public evictions = 0;

    constructor(maxSizeMb?: number) {
        this._maxSize = (maxSizeMb ?? env.vectorCacheSizeMb) * 1024 * 1024;
        logger.info(`[VectorCache] Initialized with ${this._maxSize / 1024 / 1024}MB limit.`);
    }

    get sizeBytes() {
        return this._currentSize;
    }

    get(id: string): CachedVector[] | undefined {
        const items = this.cache.get(id);
        if (items) {
            this.hits++;
            // Move to end (LRU) - But Map iteration order is key-based. 
            // To implement true LRU, we need to re-insert.
            this.cache.delete(id);
            this.cache.set(id, items);
            return items;
        }
        this.misses++;
        return undefined;
    }

    set(id: string, items: CachedVector[]) {
        // Remove existing to update size
        this.delete(id);

        // Calculate size:
        // Key (uuid=36) + Array overhead + Items * (Structure + F32 + string overhead)
        let size = 36 + 64;
        for (const item of items) {
            size += item.vector.byteLength + 100; // 100 bytes est for sector/userId strings and obj overhead
        }

        // Evict if needed
        while (this._currentSize + size > this._maxSize && this.cache.size > 0) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) this.delete(firstKey);
            this.evictions++;
        }

        if (this._currentSize + size <= this._maxSize) {
            this.cache.set(id, items);
            this._currentSize += size;
        } else {
            // Item too big for cache or cache empty but too small?
            // Just ignore.
        }
    }

    delete(id: string) {
        const items = this.cache.get(id);
        if (items) {
            let size = 36 + 64;
            for (const item of items) {
                size += item.vector.byteLength + 100;
            }
            this._currentSize -= size;
            this.cache.delete(id);
        }
    }

    clear() {
        this.cache.clear();
        this._currentSize = 0;
        this.hits = 0;
        this.misses = 0;
        this.evictions = 0;
    }
}

export const vecCache = new VectorCache();
