export const v1_11_0 = {
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
    ],
    postgres: [
        /* 1.1 Encryption Key Rotation Support */
        `ALTER TABLE {m} ADD COLUMN IF NOT EXISTS encryption_key_version INTEGER DEFAULT 1`,
        `CREATE INDEX IF NOT EXISTS idx_memories_key_version ON {m}(encryption_key_version)`,
        `CREATE TABLE IF NOT EXISTS {ekr} (
            id TEXT PRIMARY KEY,
            old_version INTEGER NOT NULL,
            new_version INTEGER NOT NULL,
            status TEXT DEFAULT 'pending',
            started_at BIGINT,
            completed_at BIGINT,
            error TEXT
        )`,

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
            timestamp BIGINT NOT NULL
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
            last_triggered BIGINT,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL
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
            next_retry BIGINT,
            created_at BIGINT NOT NULL,
            completed_at BIGINT,
            FOREIGN KEY(webhook_id) REFERENCES {wh}(id) ON DELETE CASCADE
        )`,
        `CREATE INDEX IF NOT EXISTS idx_webhook_log_webhook ON {whl}(webhook_id, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_webhook_log_status ON {whl}(status, next_retry)`,

        /* 1.4 Performance Optimization Indexes */
        `CREATE INDEX IF NOT EXISTS idx_temporal_facts_subject_time ON {tf}(subject, valid_from, valid_to) WHERE valid_to IS NULL`,
        `CREATE INDEX IF NOT EXISTS idx_temporal_facts_predicate_time ON {tf}(predicate, valid_from DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_waypoints_user_weight ON {w}(user_id, weight DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_memories_metadata ON {m} USING GIN (metadata) WHERE metadata IS NOT NULL`,

        /* 1.5 Rate Limiting Tables */
        `CREATE TABLE IF NOT EXISTS {rl} (
            key TEXT PRIMARY KEY,
            window_start BIGINT NOT NULL,
            request_count INTEGER DEFAULT 0,
            cost_units INTEGER DEFAULT 0,
            last_request BIGINT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON {rl}(window_start)`,

        /* 1.6 Configuration Tables */
        `CREATE TABLE IF NOT EXISTS {cfg} (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            type TEXT NOT NULL,
            description TEXT,
            updated_at BIGINT NOT NULL,
            updated_by TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS {ff} (
            name TEXT PRIMARY KEY,
            enabled BOOLEAN DEFAULT FALSE,
            rollout_percentage INTEGER DEFAULT 0,
            conditions TEXT,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL
        )`,
    ],
};
