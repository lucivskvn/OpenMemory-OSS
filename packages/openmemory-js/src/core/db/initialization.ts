/**
 * @file Database Initialization
 * Database setup, schema creation, and migration logic.
 * Extracted from db_access.ts for better memory management.
 */
import { logger as dbLogger } from "../../utils/logger";
import { env } from "../cfg";
import { 
    getContextId, 
    getIsPg, 
    get_sq_db, 
    get_lifecycle_lock, 
    pg 
} from "./connection";
import { TABLES, clearTableCache } from "./tables";
import { populateQ } from "./population";

export const init = async () => {
    const cid = getContextId();
    const readyStates = new Map<string, boolean>();
    
    if (readyStates.get(cid)) return;

    const release = await (async () => {
        let r: () => void;
        const p = new Promise<void>((resolve) => { r = resolve; });
        const old = get_lifecycle_lock();
        const lifecycle_locks = new Map<string, Promise<void>>();
        lifecycle_locks.set(cid, p);
        await Promise.race([old, new Promise((_, reject) => setTimeout(() => reject(new Error(`DB Lock Timeout (init)`)), 5000))]).catch(e => dbLogger.warn(e instanceof Error ? e.message : String(e)));
        return r!;
    })();

    try {
        if (readyStates.get(cid)) return;

        // Reset local caches to avoid stale table names or state
        clearTableCache();

        // Populate the q object with repository methods
        populateQ();

        if (getIsPg()) {
            const client = await pg!.connect();
            try {
                await client.query("BEGIN");
                dbLogger.info(`[DB] Creating tables in Postgres (Schema: ${env.pgSchema})...`);

                // Core Tables
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.memories} (id text PRIMARY KEY, user_id text, segment integer DEFAULT 0, content text NOT NULL, simhash text, primary_sector text NOT NULL, tags text, metadata text, created_at bigint, updated_at bigint, last_seen_at bigint, salience double precision, decay_lambda double precision, version integer DEFAULT 1, mean_dim integer, mean_vec bytea, compressed_vec bytea, feedback_score double precision DEFAULT 0, generated_summary text, coactivations integer DEFAULT 0, encryption_key_version integer DEFAULT 1)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.vectors} (id text, sector text, user_id text, v bytea, dim integer NOT NULL, metadata text, PRIMARY KEY(id, sector))`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.waypoints} (src_id text, dst_id text NOT NULL, user_id text, weight double precision NOT NULL, created_at bigint, updated_at bigint, PRIMARY KEY(src_id, dst_id, user_id))`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.embed_logs} (id text PRIMARY KEY, user_id text, model text, status text, ts bigint, err text)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.users} (user_id text PRIMARY KEY, summary text, reflection_count integer DEFAULT 0, created_at bigint, updated_at bigint)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.stats} (id serial PRIMARY KEY, type text NOT NULL, count integer DEFAULT 1, ts bigint NOT NULL, user_id text)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.maint_logs} (id serial PRIMARY KEY, op text NOT NULL, status text NOT NULL, details text, ts bigint NOT NULL, user_id text)`);

                // Temporal Graph
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.temporal_facts} (id text PRIMARY KEY, user_id text, subject text NOT NULL, predicate text NOT NULL, object text NOT NULL, valid_from bigint NOT NULL, valid_to bigint, confidence double precision NOT NULL, last_updated bigint NOT NULL, metadata text)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.temporal_edges} (id text PRIMARY KEY, user_id text, source_id text NOT NULL, target_id text NOT NULL, relation_type text NOT NULL, valid_from bigint NOT NULL, valid_to bigint, weight double precision NOT NULL, metadata text, last_updated bigint)`);

                // System & Auth
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.learned_models} (user_id text PRIMARY KEY, weights text, biases text, version integer DEFAULT 1, updated_at bigint)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.source_configs} (user_id text, type text, config text NOT NULL, status text DEFAULT 'enabled', created_at bigint, updated_at bigint, PRIMARY KEY(user_id, type))`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.api_keys} (key_hash text PRIMARY KEY, user_id text NOT NULL, role text NOT NULL DEFAULT 'user', note text, created_at bigint, updated_at bigint, expires_at bigint)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.encryption_keys} (id text PRIMARY KEY, old_version integer NOT NULL, new_version integer NOT NULL, status text DEFAULT 'pending', started_at bigint, completed_at bigint, error text)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.audit_logs} (id text PRIMARY KEY, user_id text, action text NOT NULL, resource_type text NOT NULL, resource_id text, ip_address text, user_agent text, metadata text, timestamp bigint not null)`);

                // Webhooks & Scaling
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.webhooks} (id text PRIMARY KEY, user_id text NOT NULL, url text NOT NULL, events text NOT NULL, secret text NOT NULL, status text DEFAULT 'active', retry_count integer DEFAULT 0, last_triggered bigint, created_at bigint not null, updated_at bigint not null)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.webhook_logs} (id text PRIMARY KEY, webhook_id text not null, event_type text not null, payload text not null, status text not null, response_code integer, response_body text, attempt_count integer DEFAULT 1, next_retry bigint, created_at bigint not null, completed_at bigint)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.system_locks} (lock_key text PRIMARY KEY, token text, expires_at bigint)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.rate_limits} (key text PRIMARY KEY, window_start bigint not null, request_count integer DEFAULT 0, cost_units integer DEFAULT 0, last_request bigint not null)`);

                // Configuration & Flags
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.config} (key text PRIMARY KEY, value text not null, type text not null, description text, updated_at bigint not null, updated_by text)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.feature_flags} (name text PRIMARY KEY, enabled boolean DEFAULT false, rollout_percentage integer DEFAULT 0, conditions text, created_at bigint, updated_at bigint)`);

                // Indices for Postgres
                await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_user ON ${TABLES.memories}(user_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_sector ON ${TABLES.memories}(primary_sector)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_ts ON ${TABLES.memories}(last_seen_at DESC)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_metadata ON ${TABLES.memories} USING GIN(metadata) WHERE metadata IS NOT NULL`).catch(() => { });
                await client.query(`CREATE INDEX IF NOT EXISTS idx_vectors_user ON ${TABLES.vectors}(user_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_temporal_facts_user ON ${TABLES.temporal_facts}(user_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_temporal_subject ON ${TABLES.temporal_facts}(subject)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON ${TABLES.rate_limits}(window_start)`);

                await client.query("COMMIT");
            } catch (e) {
                await client.query("ROLLBACK");
                throw e;
            } finally {
                client.release();
            }
        } else {
            const d = await get_sq_db();
            const dbPath = env.dbPath || ":memory:";
            dbLogger.info(`[DB] Init SQLite at ${dbPath} (isPg: ${getIsPg()})`);
            const tx = d.transaction(() => {
                dbLogger.info(`[DB] Creating tables in ${dbPath}...`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.memories} (id text PRIMARY KEY, user_id text, segment integer DEFAULT 0, content text NOT NULL, simhash text, primary_sector text NOT NULL, tags text, metadata text, created_at integer, updated_at integer, last_seen_at integer, salience real, decay_lambda real, version integer DEFAULT 1, mean_dim integer, mean_vec blob, compressed_vec blob, feedback_score real DEFAULT 0, generated_summary text, coactivations integer DEFAULT 0, encryption_key_version integer DEFAULT 1)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.vectors} (id text, sector text, user_id text, v blob, dim integer NOT NULL, metadata text, PRIMARY KEY(id, sector))`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.waypoints} (src_id text, dst_id text NOT NULL, user_id text, weight real NOT NULL, created_at integer, updated_at integer, PRIMARY KEY(src_id, dst_id, user_id))`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.embed_logs} (id text PRIMARY KEY, user_id text, model text, status text, ts integer, err text)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.users} (user_id text PRIMARY KEY, summary text, reflection_count integer DEFAULT 0, created_at integer, updated_at integer)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.stats} (id integer PRIMARY KEY AUTOINCREMENT, type text NOT NULL, count integer DEFAULT 1, ts integer NOT NULL, user_id text)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.maint_logs} (id integer PRIMARY KEY AUTOINCREMENT, op text NOT NULL, status text NOT NULL, details text, ts integer NOT NULL, user_id text)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.temporal_facts} (id text PRIMARY KEY, user_id text, subject text NOT NULL, predicate text NOT NULL, object text NOT NULL, valid_from integer NOT NULL, valid_to integer, confidence real NOT NULL, last_updated integer NOT NULL, metadata text)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.temporal_edges} (id text PRIMARY KEY, user_id text, source_id text NOT NULL, target_id text NOT NULL, relation_type text NOT NULL, valid_from integer NOT NULL, valid_to integer, weight real NOT NULL, metadata text, last_updated integer)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.learned_models} (user_id text PRIMARY KEY, weights text, biases text, version integer DEFAULT 1, updated_at integer)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.source_configs} (user_id text, type text, config text NOT NULL, status text DEFAULT 'enabled', created_at integer, updated_at integer, PRIMARY KEY(user_id, type))`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.api_keys} (key_hash text PRIMARY KEY, user_id text NOT NULL, role text NOT NULL DEFAULT 'user', note text, created_at integer, updated_at integer, expires_at integer)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.encryption_keys} (id text PRIMARY KEY, old_version integer NOT NULL, new_version integer NOT NULL, status text DEFAULT 'pending', started_at integer, completed_at integer, error text)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.audit_logs} (id text PRIMARY KEY, user_id text, action text NOT NULL, resource_type text NOT NULL, resource_id text, ip_address text, user_agent text, metadata text, timestamp integer not null)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.webhooks} (id text PRIMARY KEY, user_id text NOT NULL, url text NOT NULL, events text NOT NULL, secret text NOT NULL, status text DEFAULT 'active', retry_count integer DEFAULT 0, last_triggered integer, created_at integer not null, updated_at integer not null)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.webhook_logs} (id text PRIMARY KEY, webhook_id text not null, event_type text not null, payload text not null, status text not null, response_code integer, response_body text, attempt_count integer DEFAULT 1, next_retry integer, created_at integer not null, completed_at integer)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.system_locks} (lock_key text PRIMARY KEY, token text, expires_at integer)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.rate_limits} (key text PRIMARY KEY, window_start integer not null, request_count integer DEFAULT 0, cost_units integer DEFAULT 0, last_request integer not null)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.config} (key text PRIMARY KEY, value text not null, type text not null, description text, updated_at integer not null, updated_by text)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.feature_flags} (name text PRIMARY KEY, enabled boolean DEFAULT false, rollout_percentage integer DEFAULT 0, conditions text, created_at integer, updated_at integer)`);

                // Indices for SQLite
                d.exec(`CREATE INDEX IF NOT EXISTS idx_memories_user ON ${TABLES.memories}(user_id)`);
                d.exec(`CREATE INDEX IF NOT EXISTS idx_memories_sector ON ${TABLES.memories}(primary_sector)`);
                d.exec(`CREATE INDEX IF NOT EXISTS idx_memories_ts ON ${TABLES.memories}(last_seen_at DESC)`);
                d.exec(`CREATE INDEX IF NOT EXISTS idx_vectors_user ON ${TABLES.vectors}(user_id)`);
                d.exec(`CREATE INDEX IF NOT EXISTS idx_temporal_facts_user ON ${TABLES.temporal_facts}(user_id)`);
                d.exec(`CREATE INDEX IF NOT EXISTS idx_temporal_subject ON ${TABLES.temporal_facts}(subject)`);
                d.exec(`CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON ${TABLES.rate_limits}(window_start)`);

                // Auto-migrations catch-up
                try { d.exec(`ALTER TABLE ${TABLES.memories} ADD COLUMN generated_summary text`); } catch (e) { }
                try { d.exec(`ALTER TABLE ${TABLES.memories} ADD COLUMN coactivations integer DEFAULT 0`); } catch (e) { }
                try { d.exec(`ALTER TABLE ${TABLES.memories} ADD COLUMN encryption_key_version integer DEFAULT 1`); } catch (e) { }
                try { d.exec(`ALTER TABLE ${TABLES.vectors} ADD COLUMN metadata text`); } catch (e) { }
                dbLogger.info(`[DB] Tables Created in ${dbPath}`);
            });
            tx();
        }
        readyStates.set(cid, true);
    } catch (e) {
        dbLogger.error("[DB] Init failed", { error: e });
        throw e;
    } finally {
        release();
    }
};