/**
 * @file cache.ts
 * @description Lightweight LRU-like cache for critical performance optimizations.
 * Maintains a Map of items with automatic eviction of the Least Recently Used (LRU) item
 * once the maximum size is reached. Supports TTL-based expiration.
 */

/**
 * Options for cache initialization.
 */
export interface CacheOptions {
    /** Maximum number of items to store before eviction starts. Default: 1000 */
    maxSize?: number;
    /** Default Time-To-Live in milliseconds. Default: 3600000 (1 hour) */
    ttlMs?: number;
}

/**
 * Standard implementation of an LRU-like cache using Map insertion order.
 */
export class SimpleCache<K, V> {
    private cache = new Map<K, { value: V; expires: number }>();
    private readonly maxSize: number;
    private readonly ttlMs: number;

    constructor(options: CacheOptions = {}) {
        this.maxSize = options.maxSize || 1000;
        this.ttlMs = options.ttlMs || 3600000; // Default 1 hour
    }

    /**
     * Stores a value in the cache.
     * @param key - Unique key for the item.
     * @param value - The value to store.
     * @param ttlMs - Optional override for TTL.
     */
    set(key: K, value: V, ttlMs?: number): void {
        const effectiveTtl = ttlMs ?? this.ttlMs;
        const expires = Date.now() + effectiveTtl;

        if (this.cache.has(key)) {
            // Key exists, update it and refresh its position to MRU
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // New key and we are at capacity, evict oldest
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) {
                this.cache.delete(firstKey);
            }
        }

        this.cache.set(key, { value, expires });
    }

    /**
     * Retrieves an item from the cache.
     * Refreshes the item's position to mark it as Most Recently Used.
     * @param key - The key to look up.
     * @returns The value if found and not expired, otherwise undefined.
     */
    get(key: K): V | undefined {
        const item = this.cache.get(key);
        if (!item) return undefined;

        if (Date.now() > item.expires) {
            this.cache.delete(key);
            return undefined;
        }

        // Move to end (most recently used)
        this.cache.delete(key);
        this.cache.set(key, item);

        return item.value;
    }

    /**
     * Explicitly removes an item from the cache.
     */
    delete(key: K): void {
        this.cache.delete(key);
    }

    /**
     * Clears all items from the cache.
     */
    clear(): void {
        this.cache.clear();
    }

    /**
     * Returns the current number of items in the cache.
     */
    get size(): number {
        return this.cache.size;
    }
}
