/**
 * @file Database Tables
 * Table definitions and schema management.
 * Extracted from db_access.ts for better memory management.
 */
import { env } from "../cfg";
import { validateTableName } from "../security";
import { getIsPg } from "./connection";

let _tableCache: Record<string, string> | null = null;

const getTable = (key: keyof typeof TABLES): string => {
    if (_tableCache && _tableCache[key]) return _tableCache[key];
    if (!_tableCache) _tableCache = {};

    const isPg = getIsPg();
    const rawTable = (() => {
        if (!isPg) {
            // SQLite Names (Simple)
            switch (key) {
                case "memories": return "memories";
                case "vectors": return env.vectorTable || "vectors";
                case "waypoints": return "waypoints";
                case "users": return "users";
                case "stats": return "stats";
                case "maint_logs": return "maint_logs";
                case "embed_logs": return "embed_logs";
                case "temporal_facts": return "temporal_facts";
                case "temporal_edges": return "temporal_edges";
                case "learned_models": return "learned_models";
                case "source_configs": return "source_configs";
                case "api_keys": return "api_keys";
                case "encryption_keys": return "encryption_keys";
                case "audit_logs": return "audit_logs";
                case "webhooks": return "webhooks";
                case "webhook_logs": return "webhook_logs";
                case "system_locks": return "system_locks";
                case "rate_limits": return "rate_limits";
                case "config": return "config";
                case "feature_flags": return "feature_flags";
                default: return key;
            }
        }

        // Postgres Names (Namespaced)
        switch (key) {
            case "memories": return env.pgTable || "openmemory_memories";
            case "vectors": return `${env.pgTable || "openmemory_memories"}_vectors`;
            case "waypoints": return `${env.pgTable || "openmemory_memories"}_waypoints`;
            case "users": return env.usersTable || "users";
            case "stats": return `${env.pgTable || "openmemory_memories"}_stats`;
            case "maint_logs": return `${env.pgTable || "openmemory_memories"}_maint_logs`;
            case "embed_logs": return `${env.pgTable || "openmemory_memories"}_embed_logs`;
            case "temporal_facts": return `${env.pgTable || "openmemory_memories"}_temporal_facts`;
            case "temporal_edges": return `${env.pgTable || "openmemory_memories"}_temporal_edges`;
            case "learned_models": return `${env.pgTable || "openmemory_memories"}_learned_models`;
            case "source_configs": return `${env.pgTable || "openmemory_memories"}_source_configs`;
            case "api_keys": return `${env.pgTable || "openmemory_memories"}_api_keys`;
            case "encryption_keys": return `${env.pgTable || "openmemory_memories"}_encryption_keys`;
            case "audit_logs": return `${env.pgTable || "openmemory_memories"}_audit_logs`;
            case "webhooks": return `${env.pgTable || "openmemory_memories"}_webhooks`;
            case "webhook_logs": return `${env.pgTable || "openmemory_memories"}_webhook_logs`;
            case "system_locks": return "system_locks";
            case "rate_limits": return `${env.pgTable || "openmemory_memories"}_rate_limits`;
            case "config": return `${env.pgTable || "openmemory_memories"}_config`;
            case "feature_flags": return `${env.pgTable || "openmemory_memories"}_feature_flags`;
            default: return key;
        }
    })();

    const name = validateTableName(rawTable);
    _tableCache[key] = isPg ? `"${env.pgSchema}"."${name}"` : name;
    return _tableCache[key];
};

export const TABLES = {
    get memories() { return getTable("memories"); },
    get vectors() { return getTable("vectors"); },
    get waypoints() { return getTable("waypoints"); },
    get users() { return getTable("users"); },
    get stats() { return getTable("stats"); },
    get maint_logs() { return getTable("maint_logs"); },
    get embed_logs() { return getTable("embed_logs"); },
    get temporal_facts() { return getTable("temporal_facts"); },
    get temporal_edges() { return getTable("temporal_edges"); },
    get learned_models() { return getTable("learned_models"); },
    get source_configs() { return getTable("source_configs"); },
    get api_keys() { return getTable("api_keys"); },
    get encryption_keys() { return getTable("encryption_keys"); },
    get audit_logs() { return getTable("audit_logs"); },
    get webhooks() { return getTable("webhooks"); },
    get webhook_logs() { return getTable("webhook_logs"); },
    get system_locks() { return getTable("system_locks"); },
    get rate_limits() { return getTable("rate_limits"); },
    get config() { return getTable("config"); },
    get feature_flags() { return getTable("feature_flags"); },
};

// Clear table cache when needed (used in initialization)
export const clearTableCache = () => {
    _tableCache = null;
};