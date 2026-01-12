/**
 * @file cache.ts
 * @description Lightweight LRU-like cache for critical performance optimizations.
 */

export interface CacheOptions {
    maxSize?: number;
    ttlMs?: number;
}

export class SimpleCache<K, V> {
    private cache = new Map<K, { value: V; expires: number }>();
    private readonly maxSize: number;
    private readonly ttlMs: number;

    constructor(options: CacheOptions = {}) {
        this.maxSize = options.maxSize || 1000;
        this.ttlMs = options.ttlMs || 3600000; // Default 1 hour
    }

    set(key: K, value: V): void {
        if (this.cache.size >= this.maxSize) {
            // Evict oldest (first inserted in Map)
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) this.cache.delete(firstKey);
        }

        this.cache.delete(key); // Ensure it's moved to the end
        this.cache.set(key, {
            value,
            expires: Date.now() + this.ttlMs,
        });
    }

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

    delete(key: K): void {
        this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }

    get size(): number {
        return this.cache.size;
    }
}
