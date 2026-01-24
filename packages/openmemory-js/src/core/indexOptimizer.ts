/**
 * @file Database Index Optimizer
 * Provides intelligent index creation and optimization for improved query performance
 */

import { logger } from "../utils/logger";
import { getIsPg, runAsync, TABLES } from "./db_access";
import { queryPerformanceMonitor } from "./queryOptimizer";

/**
 * Index definition for database optimization
 */
export interface IndexDefinition {
    name: string;
    table: string;
    columns: string[];
    type?: 'btree' | 'hash' | 'gin' | 'gist';
    unique?: boolean;
    partial?: string; // WHERE clause for partial index
    concurrent?: boolean; // For PostgreSQL concurrent index creation
}

/**
 * Database Index Optimizer
 * Analyzes query patterns and creates optimized indexes for better performance
 */
export class IndexOptimizer {
    private static instance: IndexOptimizer;
    private createdIndexes = new Set<string>();

    private constructor() {}

    static getInstance(): IndexOptimizer {
        if (!IndexOptimizer.instance) {
            IndexOptimizer.instance = new IndexOptimizer();
        }
        return IndexOptimizer.instance;
    }

    /**
     * Get recommended indexes based on OpenMemory query patterns
     */
    getRecommendedIndexes(): IndexDefinition[] {
        const isPg = getIsPg();
        const indexes: IndexDefinition[] = [];

        // Core memory table indexes
        indexes.push(
            // User-based queries (most common filter)
            {
                name: "idx_memories_user_sector",
                table: TABLES.memories,
                columns: ["user_id", "primary_sector"],
                type: "btree"
            },
            // Time-based queries for recent activity
            {
                name: "idx_memories_user_time",
                table: TABLES.memories,
                columns: ["user_id", "last_seen_at"],
                type: "btree"
            },
            // Salience-based queries for top memories
            {
                name: "idx_memories_user_salience",
                table: TABLES.memories,
                columns: ["user_id", "salience"],
                type: "btree"
            },
            // Simhash for deduplication
            {
                name: "idx_memories_simhash",
                table: TABLES.memories,
                columns: ["simhash", "user_id"],
                type: "btree"
            },
            // Segment-based queries
            {
                name: "idx_memories_user_segment",
                table: TABLES.memories,
                columns: ["user_id", "segment"],
                type: "btree"
            }
        );

        // Vector table indexes
        indexes.push(
            // Vector lookups by memory ID and sector
            {
                name: "idx_vectors_id_sector",
                table: TABLES.vectors,
                columns: ["id", "sector"],
                type: "btree"
            },
            // User-scoped vector queries
            {
                name: "idx_vectors_user_sector",
                table: TABLES.vectors,
                columns: ["user_id", "sector"],
                type: "btree"
            }
        );

        // Waypoints table indexes
        indexes.push(
            // Source-based waypoint lookups
            {
                name: "idx_waypoints_src_user",
                table: TABLES.waypoints,
                columns: ["src_id", "user_id"],
                type: "btree"
            },
            // Destination-based waypoint lookups
            {
                name: "idx_waypoints_dst_user",
                table: TABLES.waypoints,
                columns: ["dst_id", "user_id"],
                type: "btree"
            },
            // Weight-based queries for spreading activation
            {
                name: "idx_waypoints_weight",
                table: TABLES.waypoints,
                columns: ["weight"],
                type: "btree",
                partial: "weight > 0.1" // Only index significant weights
            }
        );

        // Temporal graph indexes
        indexes.push(
            // Subject-based fact queries
            {
                name: "idx_temporal_facts_subject_user",
                table: TABLES.temporal_facts,
                columns: ["subject", "user_id"],
                type: "btree"
            },
            // Predicate-based fact queries
            {
                name: "idx_temporal_facts_predicate_user",
                table: TABLES.temporal_facts,
                columns: ["predicate", "user_id"],
                type: "btree"
            },
            // Time-range queries
            {
                name: "idx_temporal_facts_time_range",
                table: TABLES.temporal_facts,
                columns: ["valid_from", "valid_to"],
                type: "btree"
            },
            // Edge queries
            {
                name: "idx_temporal_edges_source_user",
                table: TABLES.temporal_edges,
                columns: ["source_id", "user_id"],
                type: "btree"
            }
        );

        // PostgreSQL-specific indexes
        if (isPg) {
            indexes.push(
                // JSON metadata searches
                {
                    name: "idx_memories_metadata_gin",
                    table: TABLES.memories,
                    columns: ["metadata"],
                    type: "gin",
                    partial: "metadata IS NOT NULL"
                },
                // Full-text search on content (if needed)
                {
                    name: "idx_memories_content_gin",
                    table: TABLES.memories,
                    columns: ["to_tsvector('english', content)"],
                    type: "gin"
                }
            );
        }

        // System table indexes
        indexes.push(
            // API key lookups
            {
                name: "idx_api_keys_hash",
                table: TABLES.api_keys,
                columns: ["key_hash"],
                type: "btree",
                unique: true
            },
            // Rate limiting
            {
                name: "idx_rate_limits_window",
                table: TABLES.rate_limits,
                columns: ["window_start"],
                type: "btree"
            },
            // Audit logs
            {
                name: "idx_audit_logs_user_time",
                table: TABLES.audit_logs,
                columns: ["user_id", "timestamp"],
                type: "btree"
            }
        );

        return indexes;
    }

    /**
     * Create an index if it doesn't exist
     */
    async createIndex(index: IndexDefinition): Promise<boolean> {
        if (this.createdIndexes.has(index.name)) {
            return false; // Already created
        }

        const isPg = getIsPg();
        
        try {
            // Check if index already exists
            const exists = await this.indexExists(index.name);
            if (exists) {
                this.createdIndexes.add(index.name);
                return false;
            }

            // Build CREATE INDEX statement
            let sql = "CREATE ";
            
            if (index.unique) {
                sql += "UNIQUE ";
            }
            
            sql += "INDEX ";
            
            if (isPg && index.concurrent) {
                sql += "CONCURRENTLY ";
            }
            
            sql += `IF NOT EXISTS ${index.name} ON ${index.table}`;
            
            if (isPg && index.type && index.type !== 'btree') {
                sql += ` USING ${index.type}`;
            }
            
            // Handle column expressions vs simple columns
            const columnList = index.columns.map(col => {
                // If column contains function calls or expressions, use as-is
                if (col.includes('(') || col.includes('::')) {
                    return col;
                }
                // Otherwise, quote for PostgreSQL
                return isPg ? `"${col}"` : col;
            }).join(", ");
            
            sql += ` (${columnList})`;
            
            if (index.partial) {
                sql += ` WHERE ${index.partial}`;
            }

            await runAsync(sql, []);
            this.createdIndexes.add(index.name);
            
            logger.info(`[IndexOptimizer] Created index: ${index.name}`);
            return true;
        } catch (error) {
            logger.warn(`[IndexOptimizer] Failed to create index ${index.name}:`, { error });
            return false;
        }
    }

    /**
     * Check if an index exists
     */
    private async indexExists(indexName: string): Promise<boolean> {
        const isPg = getIsPg();
        
        try {
            if (isPg) {
                const result = await runAsync(
                    "SELECT 1 FROM pg_indexes WHERE indexname = $1",
                    [indexName]
                );
                return result > 0;
            } else {
                const result = await runAsync(
                    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
                    [indexName]
                );
                return result > 0;
            }
        } catch {
            return false;
        }
    }

    /**
     * Create all recommended indexes
     */
    async createRecommendedIndexes(): Promise<{
        created: number;
        skipped: number;
        failed: number;
    }> {
        const indexes = this.getRecommendedIndexes();
        let created = 0;
        let skipped = 0;
        let failed = 0;

        logger.info(`[IndexOptimizer] Creating ${indexes.length} recommended indexes...`);

        for (const index of indexes) {
            try {
                const wasCreated = await this.createIndex(index);
                if (wasCreated) {
                    created++;
                } else {
                    skipped++;
                }
            } catch (error) {
                failed++;
                logger.warn(`[IndexOptimizer] Failed to create index ${index.name}:`, { error });
            }
        }

        logger.info(`[IndexOptimizer] Index creation complete: ${created} created, ${skipped} skipped, ${failed} failed`);
        
        return { created, skipped, failed };
    }

    /**
     * Analyze query patterns and suggest additional indexes
     */
    async analyzeAndSuggestIndexes(): Promise<IndexDefinition[]> {
        const suggestions: IndexDefinition[] = [];
        const queryPatterns = queryPerformanceMonitor.getQueryPatterns();

        // Analyze slow query patterns
        for (const [pattern, stats] of queryPatterns) {
            if (stats.avgDuration > 100 && stats.count > 10) {
                const suggestion = this.analyzeQueryPattern(pattern);
                if (suggestion) {
                    suggestions.push(suggestion);
                }
            }
        }

        return suggestions;
    }

    /**
     * Analyze a specific query pattern and suggest an index
     */
    private analyzeQueryPattern(queryPattern: string): IndexDefinition | null {
        const isPg = getIsPg();
        
        // Look for common patterns that would benefit from indexes
        
        // Pattern: WHERE user_id = ? AND column = ?
        const userColumnMatch = queryPattern.match(/where.*user_id\s*=\s*\?.*and\s+(\w+)\s*=\s*\?/i);
        if (userColumnMatch) {
            const column = userColumnMatch[1];
            return {
                name: `idx_auto_user_${column}`,
                table: this.extractTableFromQuery(queryPattern),
                columns: ["user_id", column],
                type: "btree"
            };
        }

        // Pattern: ORDER BY column DESC with WHERE user_id
        const orderByMatch = queryPattern.match(/where.*user_id\s*=\s*\?.*order\s+by\s+(\w+)\s+desc/i);
        if (orderByMatch) {
            const column = orderByMatch[1];
            return {
                name: `idx_auto_user_${column}_desc`,
                table: this.extractTableFromQuery(queryPattern),
                columns: ["user_id", column],
                type: "btree"
            };
        }

        // Pattern: JSON queries (PostgreSQL only)
        if (isPg && queryPattern.includes("metadata") && queryPattern.includes("@>")) {
            return {
                name: "idx_auto_metadata_gin",
                table: this.extractTableFromQuery(queryPattern),
                columns: ["metadata"],
                type: "gin"
            };
        }

        return null;
    }

    /**
     * Extract table name from query pattern
     */
    private extractTableFromQuery(queryPattern: string): string {
        const fromMatch = queryPattern.match(/from\s+([^\s]+)/i);
        return fromMatch ? fromMatch[1] : "unknown_table";
    }

    /**
     * Drop an index
     */
    async dropIndex(indexName: string): Promise<boolean> {
        try {
            const isPg = getIsPg();
            const sql = isPg 
                ? `DROP INDEX IF EXISTS ${indexName}`
                : `DROP INDEX IF EXISTS ${indexName}`;
            
            await runAsync(sql, []);
            this.createdIndexes.delete(indexName);
            
            logger.info(`[IndexOptimizer] Dropped index: ${indexName}`);
            return true;
        } catch (error) {
            logger.warn(`[IndexOptimizer] Failed to drop index ${indexName}:`, { error });
            return false;
        }
    }

    /**
     * Get index usage statistics (PostgreSQL only)
     */
    async getIndexStats(): Promise<Array<{
        indexName: string;
        tableName: string;
        scans: number;
        tuplesRead: number;
        tuplesReturned: number;
    }>> {
        if (!getIsPg()) {
            return []; // SQLite doesn't provide detailed index stats
        }

        try {
            // This would require a more complex query to pg_stat_user_indexes
            // For now, return empty array
            return [];
        } catch {
            return [];
        }
    }

    /**
     * Reset tracking of created indexes
     */
    reset(): void {
        this.createdIndexes.clear();
    }
}

// Global instance
export const indexOptimizer = IndexOptimizer.getInstance();

/**
 * Initialize database indexes on startup
 */
export async function initializeIndexes(): Promise<void> {
    try {
        await indexOptimizer.createRecommendedIndexes();
    } catch (error) {
        logger.warn("[IndexOptimizer] Failed to initialize indexes:", { error });
    }
}