/**
 * @file Database Migration Engine for OpenMemory.
 * Handles schema evolution across SQLite and Postgres backends with semver tracking.
 */

import * as path from "node:path";
import { Database } from "bun:sqlite";
import { Pool } from "pg";

import { now } from "../utils";
import { logger } from "../utils/logger";
import { env } from "./cfg";
import { DistributedLock } from "../utils/lock";
import { v1_11_0 } from "./migrations/v1.11.0";

const getIsPg = () => env.metadataBackend === "postgres";

const log = (msg: string) => logger.info(`[Migrate] ${msg}`);
const start = Date.now();

interface Migration {
    version: string;
    desc: string;
    sqlite: string[];
    postgres: string[];
    rollback?: {
        sqlite: string[];
        postgres: string[];
    };
    dataIntegrityChecks?: {
        sqlite: string[];
        postgres: string[];
    };
    preConditions?: {
        sqlite: string[];
        postgres: string[];
    };
}

// Use placeholders {m}, {v}, {w}, {u}, {tf}, {te} for tables to ensure consistency with core/db.ts
export const migrations: Migration[] = [
    {
        version: "1.0.0",
        desc: "Initial Schema (Parity with openmemory-py 001)",
        sqlite: [
            `CREATE TABLE IF NOT EXISTS {m} (id TEXT PRIMARY KEY, content TEXT, primary_sector TEXT, sectors TEXT, tags TEXT, vector BLOB, norm_vector BLOB, compressed_vec BLOB, simhash TEXT, meta TEXT, user_id TEXT, segment INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER, last_seen_at INTEGER, salience REAL, decay_lambda REAL, version INTEGER, mean_dim INTEGER, mean_vec BLOB, feedback_score REAL DEFAULT 0)`,
            `CREATE INDEX IF NOT EXISTS idx_memories_sector ON {m}(primary_sector)`,
            `CREATE INDEX IF NOT EXISTS idx_memories_segment ON {m}(segment)`,
            `CREATE INDEX IF NOT EXISTS idx_memories_ts ON {m}(last_seen_at)`,
            `CREATE INDEX IF NOT EXISTS idx_memories_user ON {m}(user_id)`,
            `CREATE TABLE IF NOT EXISTS {v} (id TEXT, v BLOB, dim INTEGER, sector TEXT, user_id TEXT, PRIMARY KEY (id, sector), FOREIGN KEY(id) REFERENCES {m}(id))`,
            `CREATE INDEX IF NOT EXISTS idx_vectors_user ON {v}(user_id)`,
            `CREATE TABLE IF NOT EXISTS {w} (src_id TEXT, dst_id TEXT, dst_sector TEXT, user_id TEXT, weight REAL, created_at INTEGER, updated_at INTEGER, PRIMARY KEY (src_id, dst_id))`,
            `CREATE INDEX IF NOT EXISTS idx_waypoints_src ON {w}(src_id)`,
            `CREATE INDEX IF NOT EXISTS idx_waypoints_dst ON {w}(dst_id)`,
            `CREATE TABLE IF NOT EXISTS {tf} (id TEXT PRIMARY KEY, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER, confidence REAL NOT NULL, last_updated INTEGER NOT NULL, metadata TEXT, user_id TEXT, UNIQUE(subject, predicate, object, valid_from))`,
            `CREATE TABLE IF NOT EXISTS {te} (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation_type TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER, weight REAL NOT NULL, metadata TEXT, user_id TEXT)`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_subject ON {tf}(subject)`,
        ],
        postgres: [
            `CREATE TABLE IF NOT EXISTS {m} (id TEXT PRIMARY KEY, content TEXT, primary_sector TEXT, sectors TEXT, tags TEXT, vector BYTEA, norm_vector BYTEA, compressed_vec BYTEA, simhash TEXT, meta TEXT, user_id TEXT, segment BIGINT DEFAULT 0, created_at BIGINT, updated_at BIGINT, last_seen_at BIGINT, salience DOUBLE PRECISION, decay_lambda DOUBLE PRECISION, version INTEGER, mean_dim INTEGER, mean_vec BYTEA, feedback_score DOUBLE PRECISION DEFAULT 0)`,
            `CREATE INDEX IF NOT EXISTS idx_memories_sector ON {m}(primary_sector)`,
            `CREATE INDEX IF NOT EXISTS idx_memories_segment ON {m}(segment)`,
            `CREATE INDEX IF NOT EXISTS idx_memories_ts ON {m}(last_seen_at)`,
            `CREATE INDEX IF NOT EXISTS idx_memories_user ON {m}(user_id)`,
            `CREATE TABLE IF NOT EXISTS {v} (id TEXT, v BYTEA, dim INTEGER, sector TEXT, user_id TEXT, PRIMARY KEY (id, sector))`,
            `CREATE INDEX IF NOT EXISTS idx_vectors_user ON {v}(user_id)`,
            `CREATE TABLE IF NOT EXISTS {w} (src_id TEXT, dst_id TEXT, dst_sector TEXT, user_id TEXT, weight DOUBLE PRECISION, created_at BIGINT, updated_at BIGINT, PRIMARY KEY (src_id, dst_id))`,
            `CREATE INDEX IF NOT EXISTS idx_waypoints_src ON {w}(src_id)`,
            `CREATE INDEX IF NOT EXISTS idx_waypoints_dst ON {w}(dst_id)`,
            `CREATE TABLE IF NOT EXISTS {tf} (id TEXT PRIMARY KEY, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL, valid_from BIGINT NOT NULL, valid_to BIGINT, confidence DOUBLE PRECISION NOT NULL, last_updated BIGINT NOT NULL, metadata TEXT, user_id TEXT, UNIQUE(subject, predicate, object, valid_from))`,
            `CREATE TABLE IF NOT EXISTS {te} (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation_type TEXT NOT NULL, valid_from BIGINT NOT NULL, valid_to BIGINT, weight DOUBLE PRECISION NOT NULL, metadata TEXT, user_id TEXT)`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_subject ON {tf}(subject)`,
        ],
    },
    {
        version: "1.2.0",
        desc: "Multi-user tenant support",
        sqlite: [
            `ALTER TABLE {m} ADD COLUMN user_id TEXT`,
            `CREATE INDEX IF NOT EXISTS idx_memories_user ON {m}(user_id)`,
            `ALTER TABLE {v} ADD COLUMN user_id TEXT`,
            `CREATE INDEX IF NOT EXISTS idx_vectors_user ON {v}(user_id)`,
            `CREATE TABLE IF NOT EXISTS waypoints_new (
        src_id TEXT, dst_id TEXT NOT NULL, user_id TEXT,
        weight REAL NOT NULL, created_at INTEGER, updated_at INTEGER,
        PRIMARY KEY(src_id, user_id)
      )`,
            `INSERT INTO waypoints_new SELECT src_id, dst_id, NULL, weight, created_at, updated_at FROM {w}`,
            `DROP TABLE {w}`,
            `ALTER TABLE waypoints_new RENAME TO {w}`,
            `CREATE INDEX IF NOT EXISTS idx_waypoints_src ON {w}(src_id)`,
            `CREATE INDEX IF NOT EXISTS idx_waypoints_dst ON {w}(dst_id)`,
            `CREATE INDEX IF NOT EXISTS idx_waypoints_user ON {w}(user_id)`,
            `CREATE TABLE IF NOT EXISTS {u} (
        user_id TEXT PRIMARY KEY, summary TEXT,
        reflection_count INTEGER DEFAULT 0,
        created_at INTEGER, updated_at INTEGER
      )`,
            `CREATE TABLE IF NOT EXISTS {s} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL, count INTEGER DEFAULT 1, ts INTEGER NOT NULL
      )`,
            `CREATE INDEX IF NOT EXISTS idx_stats_ts ON {s}(ts)`,
            `CREATE INDEX IF NOT EXISTS idx_stats_type ON {s}(type)`,
        ],
        postgres: [
            `ALTER TABLE {m} ADD COLUMN IF NOT EXISTS user_id TEXT`,
            `CREATE INDEX IF NOT EXISTS openmemory_memories_user_idx ON {m}(user_id)`,
            `ALTER TABLE {v} ADD COLUMN IF NOT EXISTS user_id TEXT`,
            `CREATE INDEX IF NOT EXISTS openmemory_vectors_user_idx ON {v}(user_id)`,
            `ALTER TABLE {w} ADD COLUMN IF NOT EXISTS user_id TEXT`,
            `ALTER TABLE {w} DROP CONSTRAINT IF EXISTS waypoints_pkey`,
            `ALTER TABLE {w} ADD PRIMARY KEY (src_id, user_id)`,
            `CREATE INDEX IF NOT EXISTS openmemory_waypoints_user_idx ON {w}(user_id)`,
            `CREATE TABLE IF NOT EXISTS {u} (
        user_id TEXT PRIMARY KEY, summary TEXT,
        reflection_count INTEGER DEFAULT 0,
        created_at BIGINT, updated_at BIGINT
      )`,
        ],
    },
    {
        version: "1.3.0",
        desc: "Temporal Graph user_id support",
        sqlite: [
            `ALTER TABLE {tf} ADD COLUMN user_id TEXT`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_facts_user ON {tf}(user_id)`,
            `ALTER TABLE {te} ADD COLUMN user_id TEXT`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_edges_user ON {te}(user_id)`,
        ],
        postgres: [
            `ALTER TABLE {tf} ADD COLUMN IF NOT EXISTS user_id TEXT`,
            `CREATE INDEX IF NOT EXISTS temporal_facts_user_idx ON {tf}(user_id)`,
            `ALTER TABLE {te} ADD COLUMN IF NOT EXISTS user_id TEXT`,
            `CREATE INDEX IF NOT EXISTS temporal_edges_user_idx ON {te}(user_id)`,
        ],
    },
    {
        version: "1.4.0",
        desc: "Fixed waypoint primary key and cascading deletions support",
        sqlite: [
            `CREATE TABLE IF NOT EXISTS waypoints_v2 (
                src_id TEXT, dst_id TEXT NOT NULL, user_id TEXT,
                weight REAL NOT NULL, created_at INTEGER, updated_at INTEGER,
                PRIMARY KEY(src_id, dst_id, user_id)
            )`,
            `INSERT OR IGNORE INTO waypoints_v2 SELECT * FROM {w}`,
            `DROP TABLE {w}`,
            `ALTER TABLE waypoints_v2 RENAME TO {w}`,
            `CREATE INDEX IF NOT EXISTS idx_waypoints_src ON {w}(src_id)`,
            `CREATE INDEX IF NOT EXISTS idx_waypoints_dst ON {w}(dst_id)`,
            `CREATE INDEX IF NOT EXISTS idx_waypoints_user ON {w}(user_id)`,
        ],
        postgres: [
            `ALTER TABLE {w} DROP CONSTRAINT IF EXISTS waypoints_pkey`,
            `ALTER TABLE {w} ADD PRIMARY KEY (src_id, dst_id, user_id)`,
        ],
    },
    {
        version: "1.5.0",
        desc: "Standardize meta -> metadata column name",
        sqlite: [`ALTER TABLE {m} RENAME COLUMN meta TO metadata`],
        postgres: [`ALTER TABLE {m} RENAME COLUMN meta TO metadata`],
    },
    {
        version: "1.6.0",
        desc: "Standardize anonymous userId to NULL",
        sqlite: [
            `UPDATE {tf} SET user_id = NULL WHERE user_id = 'anonymous'`,
            `UPDATE {te} SET user_id = NULL WHERE user_id = 'anonymous'`,
            `UPDATE {v} SET user_id = NULL WHERE user_id = 'anonymous'`,
        ],
        postgres: [
            `UPDATE {tf} SET user_id = NULL WHERE user_id = 'anonymous'`,
            `UPDATE {te} SET user_id = NULL WHERE user_id = 'anonymous'`,
            `UPDATE {v} SET user_id = NULL WHERE user_id = 'anonymous'`,
        ],
    },
    {
        version: "1.7.0",
        desc: "Add performance indices for temporal queries and timelines",
        sqlite: [
            `CREATE INDEX IF NOT EXISTS idx_temporal_predicate_object ON {tf}(predicate, object)`,
            `CREATE INDEX IF NOT EXISTS idx_memories_user_ts ON {m}(user_id, last_seen_at DESC)`,
        ],
        postgres: [
            `CREATE INDEX IF NOT EXISTS temporal_facts_pred_obj_idx ON {tf}(predicate, object)`,
            `CREATE INDEX IF NOT EXISTS memories_user_ts_idx ON {m}(user_id, last_seen_at DESC)`,
        ],
    },
    {
        version: "1.8.0",
        desc: "Add last_updated to temporal edges and relationship indices",
        sqlite: [
            `ALTER TABLE {te} ADD COLUMN last_updated INTEGER DEFAULT 0`,
            `UPDATE {te} SET last_updated = valid_from`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_edges_source ON {te}(source_id)`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_edges_target ON {te}(target_id)`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_edges_type ON {te}(relation_type)`,
        ],
        postgres: [
            `ALTER TABLE {te} ADD COLUMN IF NOT EXISTS last_updated BIGINT`,
            `UPDATE {te} SET last_updated = valid_from WHERE last_updated IS NULL`,
            `CREATE INDEX IF NOT EXISTS temporal_edges_source_idx ON {te}(source_id)`,
            `CREATE INDEX IF NOT EXISTS temporal_edges_target_idx ON {te}(target_id)`,
            `CREATE INDEX IF NOT EXISTS temporal_edges_type_idx ON {te}(relation_type)`,
        ],
    },
    {
        version: "1.9.0",
        desc: "Add validity range indices for optimized time-travel queries",
        sqlite: [
            `CREATE INDEX IF NOT EXISTS idx_temporal_facts_validity ON {tf}(valid_from, valid_to)`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_edges_validity ON {te}(valid_from, valid_to)`,
        ],
        postgres: [
            `CREATE INDEX IF NOT EXISTS temporal_facts_validity_idx ON {tf}(valid_from, valid_to)`,
            `CREATE INDEX IF NOT EXISTS temporal_edges_validity_idx ON {te}(valid_from, valid_to)`,
        ],
    },
    {
        version: "1.10.0",
        desc: "Enforce temporal sequence integrity via CHECK constraints",
        sqlite: [
            // SQLite requires table recreation for CHECK constraints on existing tables
            `CREATE TABLE {tf}_new (id TEXT PRIMARY KEY, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER, confidence REAL NOT NULL, last_updated INTEGER NOT NULL, metadata TEXT, user_id TEXT, UNIQUE(subject, predicate, object, valid_from), CHECK (valid_to IS NULL OR valid_to >= valid_from))`,
            `INSERT OR IGNORE INTO {tf}_new SELECT * FROM {tf}`,
            `DROP TABLE {tf}`,
            `ALTER TABLE {tf}_new RENAME TO {tf}`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_subject ON {tf}(subject)`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_facts_user ON {tf}(user_id)`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_predicate_object ON {tf}(predicate, object)`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_facts_validity ON {tf}(valid_from, valid_to)`,

            `CREATE TABLE {te}_new (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation_type TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER, weight REAL NOT NULL, metadata TEXT, user_id TEXT, last_updated INTEGER DEFAULT 0, CHECK (valid_to IS NULL OR valid_to >= valid_from))`,
            `INSERT OR IGNORE INTO {te}_new SELECT * FROM {te}`,
            `DROP TABLE {te}`,
            `ALTER TABLE {te}_new RENAME TO {te}`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_edges_user ON {te}(user_id)`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_edges_source ON {te}(source_id)`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_edges_target ON {te}(target_id)`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_edges_type ON {te}(relation_type)`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_edges_validity ON {te}(valid_from, valid_to)`,
        ],
        postgres: [
            `ALTER TABLE {tf} ADD CONSTRAINT check_tf_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from)`,
            `ALTER TABLE {te} ADD CONSTRAINT check_te_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from)`,
        ],
    },
    {
        version: "1.11.0",
        desc: "v2.4.0 Production Readiness Schema",
        sqlite: [
            /* 1.1 Encryption Key Rotation Support */
            `ALTER TABLE {m} ADD COLUMN encryption_key_version INTEGER DEFAULT 1`,
            `CREATE INDEX IF NOT EXISTS idx_memories_key_version ON {m}(encryption_key_version)`,
            `CREATE TABLE IF NOT EXISTS {ekr} (
                id TEXT PRIMARY KEY,
                old_version INTEGER NOT NULL,
                new_version INTEGER NOT NULL,
                status TEXT DEFAULT 'pending',
                started_at INTEGER,
                completed_at INTEGER,
                error TEXT
            )`,
            `ALTER TABLE {s} ADD COLUMN user_id TEXT`,

            /* 1.2 Audit Logging Tables */
            `CREATE TABLE IF NOT EXISTS {al} (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                action TEXT NOT NULL,
                resource_type TEXT NOT NULL,
                resource_id TEXT,
                ip_address TEXT,
                user_agent TEXT,
                metadata TEXT,
                timestamp INTEGER NOT NULL
            )`,
            `CREATE INDEX IF NOT EXISTS idx_audit_user ON {al}(user_id, timestamp DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_audit_action ON {al}(action, timestamp DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_audit_resource ON {al}(resource_type, resource_id)`,

            /* 1.3 Webhook System Tables */
            `CREATE TABLE IF NOT EXISTS {wh} (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                url TEXT NOT NULL,
                events TEXT NOT NULL,
                secret TEXT NOT NULL,
                status TEXT DEFAULT 'active',
                retry_count INTEGER DEFAULT 0,
                last_triggered INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )`,
            `CREATE INDEX IF NOT EXISTS idx_webhooks_user ON {wh}(user_id)`,
            `CREATE INDEX IF NOT EXISTS idx_webhooks_status ON {wh}(status)`,

            `CREATE TABLE IF NOT EXISTS {whl} (
                id TEXT PRIMARY KEY,
                webhook_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                status TEXT NOT NULL,
                response_code INTEGER,
                response_body TEXT,
                attempt_count INTEGER DEFAULT 1,
                next_retry INTEGER,
                created_at INTEGER NOT NULL,
                completed_at INTEGER,
                FOREIGN KEY(webhook_id) REFERENCES {wh}(id) ON DELETE CASCADE
            )`,
            `CREATE INDEX IF NOT EXISTS idx_webhook_log_webhook ON {whl}(webhook_id, created_at DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_webhook_log_status ON {whl}(status, next_retry)`,

            /* 1.4 Performance Optimization Indexes */
            `CREATE INDEX IF NOT EXISTS idx_temporal_facts_subject_time ON {tf}(subject, valid_from, valid_to) WHERE valid_to IS NULL`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_facts_predicate_time ON {tf}(predicate, valid_from DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_waypoints_user_weight ON {w}(user_id, weight DESC)`,

            /* 1.5 Rate Limiting Tables */
            `CREATE TABLE IF NOT EXISTS {rl} (
                key TEXT PRIMARY KEY,
                window_start INTEGER NOT NULL,
                request_count INTEGER DEFAULT 0,
                cost_units INTEGER DEFAULT 0,
                last_request INTEGER NOT NULL
            )`,
            `CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON {rl}(window_start)`,

            /* 1.6 Configuration Tables */
            `ALTER TABLE {m} ADD COLUMN generated_summary TEXT`,
            `ALTER TABLE {v} ADD COLUMN metadata TEXT`,
            `CREATE TABLE IF NOT EXISTS {cfg} (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                type TEXT NOT NULL,
                description TEXT,
                updated_at INTEGER NOT NULL,
                updated_by TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS {ff} (
                name TEXT PRIMARY KEY,
                enabled INTEGER DEFAULT 0,
                rollout_percentage INTEGER DEFAULT 0,
                conditions TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )`,

            /* 1.7 Missing Core Tables (Parity) */
            `CREATE TABLE IF NOT EXISTS {el} (id TEXT PRIMARY KEY, user_id TEXT, model TEXT, status TEXT, ts INTEGER, err TEXT)`,
            `CREATE TABLE IF NOT EXISTS {ml} (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, status TEXT NOT NULL, details TEXT, ts INTEGER NOT NULL, user_id TEXT)`,
            `CREATE TABLE IF NOT EXISTS {ak} (key_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', note TEXT, created_at INTEGER, updated_at INTEGER, expires_at INTEGER)`,
            `CREATE TABLE IF NOT EXISTS {lm} (user_id TEXT PRIMARY KEY, weights TEXT, biases TEXT, version INTEGER DEFAULT 1, updated_at INTEGER)`,
            `CREATE TABLE IF NOT EXISTS {src} (user_id TEXT, type TEXT, config TEXT NOT NULL, status TEXT DEFAULT 'enabled', created_at INTEGER, updated_at INTEGER, PRIMARY KEY(user_id, type))`,
        ],
        postgres: [
            /* 1.1 Encryption Key Rotation Support */
            `ALTER TABLE {m} ADD COLUMN IF NOT EXISTS generated_summary TEXT`,
            `ALTER TABLE {v} ADD COLUMN IF NOT EXISTS metadata TEXT`,
            `ALTER TABLE { m } ADD COLUMN IF NOT EXISTS encryption_key_version INTEGER DEFAULT 1`,
            `CREATE INDEX IF NOT EXISTS idx_memories_key_version ON { m } (encryption_key_version)`,
            `CREATE TABLE IF NOT EXISTS { ekr } (
    id TEXT PRIMARY KEY,
        old_version INTEGER NOT NULL,
            new_version INTEGER NOT NULL,
                status TEXT DEFAULT 'pending',
                    start_at BIGINT,
                        completed_at BIGINT,
                            error TEXT
            )`,

            /* 1.2 Audit Logging Tables */
            `CREATE TABLE IF NOT EXISTS { al } (
    id TEXT PRIMARY KEY,
        user_id TEXT,
            action TEXT NOT NULL,
                resource_type TEXT NOT NULL,
                    resource_id TEXT,
                        ip_address TEXT,
                            user_agent TEXT,
                                metadata TEXT,
                                    timestamp BIGINT NOT NULL
            )`,
            `CREATE INDEX IF NOT EXISTS idx_audit_user ON { al } (user_id, timestamp DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_audit_action ON { al } (action, timestamp DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_audit_resource ON { al } (resource_type, resource_id)`,

            /* 1.3 Webhook System Tables */
            `CREATE TABLE IF NOT EXISTS { wh } (
    id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
            url TEXT NOT NULL,
                events TEXT NOT NULL,
                    secret TEXT NOT NULL,
                        status TEXT DEFAULT 'active',
                            retry_count INTEGER DEFAULT 0,
                                last_triggered BIGINT,
                                    created_at BIGINT NOT NULL,
                                        updated_at BIGINT NOT NULL
            )`,
            `CREATE INDEX IF NOT EXISTS idx_webhooks_user ON { wh } (user_id)`,
            `CREATE INDEX IF NOT EXISTS idx_webhooks_status ON { wh } (status)`,

            `CREATE TABLE IF NOT EXISTS { whl } (
    id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                    status TEXT NOT NULL,
                        response_code INTEGER,
                            response_body TEXT,
                                attempt_count INTEGER DEFAULT 1,
                                    next_retry BIGINT,
                                        created_at BIGINT NOT NULL,
                                            completed_at BIGINT,
                                                FOREIGN KEY(webhook_id) REFERENCES { wh } (id) ON DELETE CASCADE
            )`,
            `CREATE INDEX IF NOT EXISTS idx_webhook_log_webhook ON { whl } (webhook_id, created_at DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_webhook_log_status ON { whl } (status, next_retry)`,

            /* 1.4 Performance Optimization Indexes */
            `CREATE INDEX IF NOT EXISTS idx_temporal_facts_subject_time ON { tf } (subject, valid_from, valid_to) WHERE valid_to IS NULL`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_facts_predicate_time ON { tf } (predicate, valid_from DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_waypoints_user_weight ON { w } (user_id, weight DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_memories_metadata ON { m } USING GIN(metadata) WHERE metadata IS NOT NULL`,

            /* 1.5 Rate Limiting Tables */
            `CREATE TABLE IF NOT EXISTS { rl } (
    key TEXT PRIMARY KEY,
        window_start BIGINT NOT NULL,
            request_count INTEGER DEFAULT 0,
                cost_units INTEGER DEFAULT 0,
                    last_request BIGINT NOT NULL
            )`,
            `CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON { rl } (window_start)`,

            /* 1.6 Configuration Tables */
            `CREATE TABLE IF NOT EXISTS { cfg } (
    key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
            type TEXT NOT NULL,
                description TEXT,
                    updated_at BIGINT NOT NULL,
                        updated_by TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS { ff } (
    name TEXT PRIMARY KEY,
        enabled BOOLEAN DEFAULT FALSE,
            rollout_percentage INTEGER DEFAULT 0,
                conditions TEXT,
                    created_at BIGINT NOT NULL,
                        updated_at BIGINT NOT NULL
            )`,
        ],
    },
    v1_11_0,
];

interface SchemaVersionRow {
    version: string;
}

// Semver comparator: 1 if a > b, -1 if a < b, 0 if equal
function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
    }
    return 0;
}

export function getTableReplacements(isPg: boolean): Record<string, string> {
    if (isPg) {
        const sc = env.pgSchema || "public";
        // Aligned with db.ts logic for PG
        const mt = env.pgTable || "openmemory_memories";
        const vt = `${mt} _vectors`;
        const wt = `${mt} _waypoints`;
        const ut = env.usersTable || "openmemory_users";
        const st = `${mt} _stats`;
        const tft = `${mt} _temporal_facts`;
        const tet = `${mt} _temporal_edges`;
        // v1.11.0 tables
        const ekrt = `${mt} _encryption_keys`;
        const alt = `${mt} _audit_logs`;
        const wht = `${mt} _webhooks`;
        const whlt = `${mt} _webhook_logs`;
        const rlt = `${mt} _rate_limits`;
        const cfgt = `${mt} _config`;
        const fft = `${mt} _feature_flags`;

        return {
            "{m}": `"${sc}"."${mt}"`,
            "{v}": `"${sc}"."${vt}"`,
            "{w}": `"${sc}"."${wt}"`,
            "{u}": `"${sc}"."${ut}"`,
            "{s}": `"${sc}"."${st}"`,
            "{tf}": `"${sc}"."${tft}"`,
            "{te}": `"${sc}"."${tet}"`,
            "{sc}": `"${sc}"`,
            // v1.11.0 & Extras
            "{el}": `"${sc}"."${mt}_embed_logs"`,
            "{ml}": `"${sc}"."${mt}_maint_logs"`,
            "{ak}": `"${sc}"."${mt}_api_keys"`,
            "{lm}": `"${sc}"."${mt}_learned_models"`,
            "{src}": `"${sc}"."${mt}_source_configs"`,
            "{ekr}": `"${sc}"."${ekrt}"`,
            "{al}": `"${sc}"."${alt}"`,
            "{wh}": `"${sc}"."${wht}"`,
            "{whl}": `"${sc}"."${whlt}"`,
            "{rl}": `"${sc}"."${rlt}"`,
            "{cfg}": `"${sc}"."${cfgt}"`,
            "{ff}": `"${sc}"."${fft}"`,
        };
    } else {
        // SQLite replacements - consistent with db.ts
        return {
            "{m}": "memories",
            "{v}": env.vectorTable || "vectors",
            "{w}": "waypoints",
            "{u}": "users",
            "{s}": "stats",
            "{tf}": "temporal_facts",
            "{te}": "temporal_edges",
            "{sc}": "",
            // v1.11.0 & Extras
            "{el}": "embed_logs",
            "{ml}": "maint_logs",
            "{ak}": "api_keys",
            "{lm}": "learned_models",
            "{src}": "source_configs",
            "{ekr}": "encryption_keys",
            "{al}": "audit_logs",
            "{wh}": "webhooks",
            "{whl}": "webhook_logs",
            "{rl}": "rate_limits",
            "{cfg}": "config",
            "{ff}": "feature_flags",
        };
    }
}

function applyReplacements(
    sql: string,
    replacements: Record<string, string>,
): string {
    let s = sql;
    // Replace longer keys first to prevent partial matches?
    // Keys are {m}, {v}, etc. uniquely identifiable.
    for (const [k, v] of Object.entries(replacements)) {
        s = s.split(k).join(v);
    }
    return s;
}

function getDbVersionSqlite(db: Database): string | null {
    try {
        const row = db
            .prepare(
                `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`,
            )
            .get() as { name: string } | null;
        if (!row) return null;
        const ver = db
            .prepare(
                `SELECT version FROM schema_version ORDER BY applied_at DESC LIMIT 1`,
            )
            .get() as SchemaVersionRow | null;
        return ver?.version || null;
    } catch {
        return null;
    }
}

function setDbVersionSqlite(db: Database, version: string): void {
    db.run(`CREATE TABLE IF NOT EXISTS schema_version(
                            version TEXT PRIMARY KEY, applied_at INTEGER
                        )`);
    db.prepare(`INSERT OR REPLACE INTO schema_version VALUES(?, ?)`).run(
        version,
        now(),
    );
}

interface SqliteTableInfo {
    name: string;
}

function checkColumnExistsSqlite(
    db: Database,
    table: string,
    column: string,
): boolean {
    const rows = db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as SqliteTableInfo[];
    return rows.some((r) => r.name === column);
}

export async function runSqliteMigration(db: Database, m: Migration): Promise<void> {
    log(`Running migration: ${m.version} - ${m.desc} `);
    const replacements = getTableReplacements(false);

    if (m.version === "1.5.0") {
        const tableName = replacements["{m}"];
        const hasMeta = checkColumnExistsSqlite(db, tableName, "metadata");
        if (hasMeta) {
            log(`Migration ${m.version} already handled(metadata column exists), skipping`);
            setDbVersionSqlite(db, m.version);
            return;
        }
    }

    const transaction = db.transaction(() => {
        for (const rawSql of m.sqlite) {
            const sql = applyReplacements(rawSql, replacements);
            try {
                db.run(sql);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                if (!msg.includes("duplicate column")) {
                    log(`ERROR: ${msg} in SQL: ${sql} `);
                    throw err;
                }
            }
        }
    });

    transaction();

    setDbVersionSqlite(db, m.version);
    log(`Migration ${m.version} completed successfully`);
}

async function getDbVersionPg(pool: Pool): Promise<string | null> {
    try {
        const sc = env.pgSchema || "public";
        const check = await pool.query(
            `SELECT EXISTS(
                            SELECT FROM information_schema.tables 
        WHERE table_schema = $1 AND table_name = 'schema_version'
                        )`,
            [sc],
        );
        if (!check.rows[0].exists) return null;

        const ver = await pool.query(
            `SELECT version FROM "${sc}"."schema_version" ORDER BY applied_at DESC LIMIT 1`,
        );
        return ver.rows[0]?.version || null;
    } catch {
        return null;
    }
}

async function setDbVersionPg(pool: Pool, version: string): Promise<void> {
    const sc = env.pgSchema || "public";
    await pool.query(
        `CREATE TABLE IF NOT EXISTS "${sc}"."schema_version"(
                            version TEXT PRIMARY KEY, applied_at BIGINT
                        )`,
    );
    await pool.query(
        `INSERT INTO "${sc}"."schema_version" VALUES($1, $2) 
     ON CONFLICT(version) DO UPDATE SET applied_at = EXCLUDED.applied_at`,
        [version, now()],
    );
}

async function checkColumnExistsPg(
    pool: Pool,
    table: string,
    column: string,
): Promise<boolean> {
    const sc = env.pgSchema || "public";
    const tbl = table.replace(/"/g, "").split(".").pop() || table;

    const res = await pool.query(
        `SELECT EXISTS(
                            SELECT FROM information_schema.columns 
       WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
                        )`,
        [sc, tbl, column],
    );
    return res.rows[0].exists;
}

async function runPgMigration(pool: Pool, m: Migration): Promise<void> {
    log(`Running migration: ${m.version} - ${m.desc} `);
    const client = await pool.connect();
    const replacements = getTableReplacements(true);

    try {
        await client.query("BEGIN");

        if (m.version === "1.5.0") {
            const tableName = replacements["{m}"];
            const hasMeta = await checkColumnExistsPg(
                pool,
                tableName,
                "metadata",
            );
            const hasOldMeta = await checkColumnExistsPg(
                pool,
                tableName,
                "meta",
            );

            if (hasMeta || !hasOldMeta) {
                log(
                    `Migration ${m.version} already handled or not needed, skipping`,
                );
                await setDbVersionPg(pool, m.version);
                await client.query("COMMIT");
                return;
            }
        }

        for (const rawSql of m.postgres) {
            const sql = applyReplacements(rawSql, replacements);
            try {
                await client.query(sql);
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                if (
                    !msg.includes("already exists") &&
                    !msg.includes("duplicate")
                ) {
                    throw e;
                }
            }
        }

        await setDbVersionPg(pool, m.version);
        await client.query("COMMIT");
        log(`Migration ${m.version} completed successfully`);
    } catch (e) {
        await client.query("ROLLBACK");
        log(`ERROR: Migration ${m.version} failed, rolled back.`);
        throw e;
    } finally {
        client.release();
    }
}


export async function runMigrations() {
    log("Checking for pending migrations...");

    // Integrity: Ensure only one node runs migrations in multi-node clusters
    const lock = new DistributedLock("system:migrations");

    // REDUCED TIMEOUT: Wait up to 30 seconds (was 2 mins) to avoid deployment hangs
    const acquired = await lock.acquire(30000);
    if (!acquired) {
        log("Could not acquire migration lock. Skipping to avoid contention (another node might be running them).");
        return;
    }

    try {
        if (getIsPg()) {
            const ssl =
                env.pgSsl === "require"
                    ? { rejectUnauthorized: false }
                    : env.pgSsl === "disable"
                        ? false
                        : undefined;

            const pool = new Pool({
                host: env.pgHost,
                port: env.pgPort,
                database: env.pgDb,
                user: env.pgUser,
                password: env.pgPassword,
                ssl,
                connectionTimeoutMillis: 5000, // Fail fast
            });

            try {
                const current = await getDbVersionPg(pool);
                log(`Current database version: ${current || "none"} `);

                for (const m of migrations) {
                    if (!current || compareVersions(m.version, current) > 0) {
                        await runPgMigration(pool, m);
                    }
                }
            } finally {
                await pool.end();
            }
        } else {
            const dbPath = env.dbPath || ":memory:";

            // Backup SQLite DB before migration if it exists and is a file
            if (dbPath !== ":memory:" && await Bun.file(dbPath).exists() && Bun.env.NODE_ENV !== "test") {
                try {
                    const backupPath = `${dbPath}.bak.${Date.now()}`;
                    await Bun.write(backupPath, Bun.file(dbPath));
                    log(`Created database backup at ${backupPath}`);

                    // Cleanup old backups (keep last 5)
                    const dir = path.dirname(dbPath);
                    // Use fs/promises for readdir as it's the standard async way compatible with Bun
                    const { readdir, unlink } = await import("node:fs/promises");
                    const files = (await readdir(dir))
                        .filter(f => f.startsWith(path.basename(dbPath) + ".bak."))
                        .sort()
                        .reverse();

                    if (files.length > 5) {
                        for (const f of files.slice(5)) {
                            try {
                                await unlink(path.join(dir, f));
                            } catch (e) {
                                logger.warn(`[Migrate] Failed to delete old backup ${f}`, { error: e });
                            }
                        }
                    }
                } catch (err) {
                    logger.error(`[Migrate] Failed to create database backup`, { error: err });
                    throw new Error("Migration aborted: Failed to create critical backup.");
                }
            }

            const db = new Database(dbPath);
            try {
                db.exec("PRAGMA journal_mode = WAL;");
                const current = getDbVersionSqlite(db);
                log(`Current database version(SQLite): ${current || "none"} `);

                for (const m of migrations) {
                    if (!current || compareVersions(m.version, current) > 0) {
                        await runSqliteMigration(db, m);
                    }
                }
            } finally {
                db.close();
            }
        }
    } catch (err) {
        logger.error(`[Migrate] Fatal error during migrations`, { error: err });
        throw err;
    } finally {
        await lock.release();
    }
}

/**
 * Rollback database to a specific version
 */
export async function rollbackToVersion(targetVersion: string): Promise<void> {
    log(`Rolling back database to version ${targetVersion}...`);

    const lock = new DistributedLock("system:migrations");
    const acquired = await lock.acquire(30000);
    if (!acquired) {
        throw new Error("Could not acquire migration lock for rollback");
    }

    try {
        if (getIsPg()) {
            const ssl =
                env.pgSsl === "require"
                    ? { rejectUnauthorized: false }
                    : env.pgSsl === "disable"
                        ? false
                        : undefined;

            const pool = new Pool({
                host: env.pgHost,
                port: env.pgPort,
                database: env.pgDb,
                user: env.pgUser,
                password: env.pgPassword,
                ssl,
                connectionTimeoutMillis: 5000,
            });

            try {
                await rollbackPgToVersion(pool, targetVersion);
            } finally {
                await pool.end();
            }
        } else {
            const dbPath = env.dbPath || ":memory:";
            if (dbPath === ":memory:") {
                throw new Error("Cannot rollback in-memory database");
            }

            const db = new Database(dbPath);
            try {
                await rollbackSqliteToVersion(db, targetVersion);
            } finally {
                db.close();
            }
        }
    } finally {
        await lock.release();
    }
}

async function rollbackSqliteToVersion(db: Database, targetVersion: string): Promise<void> {
    const current = getDbVersionSqlite(db);
    if (!current) {
        throw new Error("No current version found, cannot rollback");
    }

    if (compareVersions(targetVersion, current) >= 0) {
        log(`Target version ${targetVersion} is not older than current ${current}, no rollback needed`);
        return;
    }

    // Find migrations to rollback (in reverse order)
    const migrationsToRollback = migrations
        .filter(m => compareVersions(m.version, targetVersion) > 0 && compareVersions(m.version, current) <= 0)
        .reverse();

    log(`Rolling back ${migrationsToRollback.length} migrations`);

    const transaction = db.transaction(() => {
        for (const m of migrationsToRollback) {
            if (!m.rollback?.sqlite) {
                throw new Error(`Migration ${m.version} does not support rollback`);
            }

            log(`Rolling back migration: ${m.version} - ${m.desc}`);
            const replacements = getTableReplacements(false);

            for (const rawSql of m.rollback.sqlite) {
                const sql = applyReplacements(rawSql, replacements);
                try {
                    db.run(sql);
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    log(`ERROR during rollback: ${msg} in SQL: ${sql}`);
                    throw err;
                }
            }
        }
    });

    transaction();
    setDbVersionSqlite(db, targetVersion);
    log(`Rollback to version ${targetVersion} completed successfully`);
}

async function rollbackPgToVersion(pool: Pool, targetVersion: string): Promise<void> {
    const current = await getDbVersionPg(pool);
    if (!current) {
        throw new Error("No current version found, cannot rollback");
    }

    if (compareVersions(targetVersion, current) >= 0) {
        log(`Target version ${targetVersion} is not older than current ${current}, no rollback needed`);
        return;
    }

    // Find migrations to rollback (in reverse order)
    const migrationsToRollback = migrations
        .filter(m => compareVersions(m.version, targetVersion) > 0 && compareVersions(m.version, current) <= 0)
        .reverse();

    log(`Rolling back ${migrationsToRollback.length} migrations`);

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        for (const m of migrationsToRollback) {
            if (!m.rollback?.postgres) {
                throw new Error(`Migration ${m.version} does not support rollback`);
            }

            log(`Rolling back migration: ${m.version} - ${m.desc}`);
            const replacements = getTableReplacements(true);

            for (const rawSql of m.rollback.postgres) {
                const sql = applyReplacements(rawSql, replacements);
                try {
                    await client.query(sql);
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    log(`ERROR during rollback: ${msg} in SQL: ${sql}`);
                    throw e;
                }
            }
        }

        await setDbVersionPg(pool, targetVersion);
        await client.query("COMMIT");
        log(`Rollback to version ${targetVersion} completed successfully`);
    } catch (e) {
        await client.query("ROLLBACK");
        log(`ERROR: Rollback to ${targetVersion} failed, rolled back transaction.`);
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Validate data integrity after migration
 */
export async function validateDataIntegrity(): Promise<boolean> {
    log("Validating data integrity...");

    try {
        if (getIsPg()) {
            const ssl =
                env.pgSsl === "require"
                    ? { rejectUnauthorized: false }
                    : env.pgSsl === "disable"
                        ? false
                        : undefined;

            const pool = new Pool({
                host: env.pgHost,
                port: env.pgPort,
                database: env.pgDb,
                user: env.pgUser,
                password: env.pgPassword,
                ssl,
                connectionTimeoutMillis: 5000,
            });

            try {
                return await validatePgIntegrity(pool);
            } finally {
                await pool.end();
            }
        } else {
            const dbPath = env.dbPath || ":memory:";
            const db = new Database(dbPath);
            try {
                return validateSqliteIntegrity(db);
            } finally {
                db.close();
            }
        }
    } catch (err) {
        logger.error(`[Migrate] Data integrity validation failed`, { error: err });
        return false;
    }
}

function validateSqliteIntegrity(db: Database): boolean {
    try {
        // Run SQLite integrity check
        const result = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
        if (result.integrity_check !== "ok") {
            log(`SQLite integrity check failed: ${result.integrity_check}`);
            return false;
        }

        // Check foreign key constraints
        const fkResult = db.prepare("PRAGMA foreign_key_check").all();
        if (fkResult.length > 0) {
            log(`Foreign key constraint violations found: ${JSON.stringify(fkResult)}`);
            return false;
        }

        // Run custom data integrity checks
        const replacements = getTableReplacements(false);
        const integrityChecks = [
            // Check that all memories have valid user_id or NULL
            `SELECT COUNT(*) as count FROM ${replacements["{m}"]} WHERE user_id = ''`,
            // Check that all vectors have corresponding memories
            `SELECT COUNT(*) as count FROM ${replacements["{v}"]} v LEFT JOIN ${replacements["{m}"]} m ON v.id = m.id WHERE m.id IS NULL`,
            // Check that all waypoints reference existing memories
            `SELECT COUNT(*) as count FROM ${replacements["{w}"]} w LEFT JOIN ${replacements["{m}"]} m ON w.src_id = m.id WHERE m.id IS NULL`,
        ];

        for (const check of integrityChecks) {
            const result = db.prepare(check).get() as { count: number };
            if (result.count > 0) {
                log(`Data integrity violation found: ${check} returned ${result.count} violations`);
                return false;
            }
        }

        log("SQLite data integrity validation passed");
        return true;
    } catch (err) {
        logger.error(`SQLite integrity validation error`, { error: err });
        return false;
    }
}

async function validatePgIntegrity(pool: Pool): Promise<boolean> {
    try {
        const replacements = getTableReplacements(true);
        
        // Run custom data integrity checks
        const integrityChecks = [
            // Check that all memories have valid user_id or NULL
            `SELECT COUNT(*) as count FROM ${replacements["{m}"]} WHERE user_id = ''`,
            // Check that all vectors have corresponding memories
            `SELECT COUNT(*) as count FROM ${replacements["{v}"]} v LEFT JOIN ${replacements["{m}"]} m ON v.id = m.id WHERE m.id IS NULL`,
            // Check that all waypoints reference existing memories
            `SELECT COUNT(*) as count FROM ${replacements["{w}"]} w LEFT JOIN ${replacements["{m}"]} m ON w.src_id = m.id WHERE m.id IS NULL`,
        ];

        for (const check of integrityChecks) {
            const result = await pool.query(check);
            const count = parseInt(result.rows[0].count);
            if (count > 0) {
                log(`Data integrity violation found: ${check} returned ${count} violations`);
                return false;
            }
        }

        log("PostgreSQL data integrity validation passed");
        return true;
    } catch (err) {
        logger.error(`PostgreSQL integrity validation error`, { error: err });
        return false;
    }
}

/**
 * Get current database version
 */
export async function getCurrentVersion(): Promise<string | null> {
    if (getIsPg()) {
        const ssl =
            env.pgSsl === "require"
                ? { rejectUnauthorized: false }
                : env.pgSsl === "disable"
                    ? false
                    : undefined;

        const pool = new Pool({
            host: env.pgHost,
            port: env.pgPort,
            database: env.pgDb,
            user: env.pgUser,
            password: env.pgPassword,
            ssl,
            connectionTimeoutMillis: 5000,
        });

        try {
            return await getDbVersionPg(pool);
        } finally {
            await pool.end();
        }
    } else {
        const dbPath = env.dbPath || ":memory:";
        const db = new Database(dbPath);
        try {
            return getDbVersionSqlite(db);
        } finally {
            db.close();
        }
    }
}

/**
 * List all available migrations
 */
export function listMigrations(): Array<{
    version: string;
    desc: string;
    hasRollback: boolean;
    hasIntegrityChecks: boolean;
}> {
    return migrations.map(m => ({
        version: m.version,
        desc: m.desc,
        hasRollback: !!(m.rollback?.sqlite || m.rollback?.postgres),
        hasIntegrityChecks: !!(m.dataIntegrityChecks?.sqlite || m.dataIntegrityChecks?.postgres),
    }));
}

