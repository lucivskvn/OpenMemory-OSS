-- 001_initial.sql
CREATE TABLE IF NOT EXISTS {m} (
    id TEXT PRIMARY KEY,
    content TEXT,
    primary_sector TEXT,
    sectors TEXT,
    tags TEXT,
    vector BLOB,
    norm_vector BLOB,
    compressed_vec BLOB,
    simhash TEXT,
    metadata TEXT,
    user_id TEXT,
    segment INTEGER DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER,
    last_seen_at INTEGER,
    salience REAL,
    decay_lambda REAL,
    version INTEGER,
    mean_dim INTEGER,
    mean_vec BLOB,
    feedback_score REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS {v} (
    id TEXT,
    v BLOB,
    dim INTEGER,
    sector TEXT,
    user_id TEXT,
    PRIMARY KEY (id, sector),
    FOREIGN KEY(id) REFERENCES {m}(id)
);
CREATE TABLE IF NOT EXISTS {u} (
    user_id TEXT PRIMARY KEY,
    summary TEXT,
    reflection_count INTEGER,
    created_at INTEGER,
    updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS {s} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER,
    metrics TEXT
);
CREATE TABLE IF NOT EXISTS embed_logs (
    id TEXT,
    model TEXT,
    status TEXT,
    ts INTEGER,
    err TEXT,
    user_id TEXT
);
CREATE TABLE IF NOT EXISTS {w} (
    src_id TEXT,
    dst_id TEXT,
    dst_sector TEXT,
    user_id TEXT,
    weight REAL,
    created_at INTEGER,
    updated_at INTEGER,
    PRIMARY KEY (src_id, dst_id)
);
CREATE TABLE IF NOT EXISTS {tf} (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    valid_from INTEGER NOT NULL,
    valid_to INTEGER,
    confidence REAL NOT NULL CHECK(
        confidence >= 0
        AND confidence <= 1
    ),
    last_updated INTEGER NOT NULL,
    metadata TEXT,
    user_id TEXT,
    UNIQUE(subject, predicate, object, valid_from)
);
CREATE TABLE IF NOT EXISTS {te} (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    valid_from INTEGER NOT NULL,
    valid_to INTEGER,
    weight REAL NOT NULL,
    metadata TEXT,
    user_id TEXT,
    FOREIGN KEY(source_id) REFERENCES {tf}(id),
    FOREIGN KEY(target_id) REFERENCES {tf}(id)
);
CREATE INDEX IF NOT EXISTS idx_memories_sector ON {m}(primary_sector);
CREATE INDEX IF NOT EXISTS idx_memories_segment ON {m}(segment);
CREATE INDEX IF NOT EXISTS idx_memories_ts ON {m}(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_memories_user ON {m}(user_id);
CREATE INDEX IF NOT EXISTS idx_vectors_user ON {v}(user_id);
CREATE INDEX IF NOT EXISTS idx_waypoints_src ON {w}(src_id);
CREATE INDEX IF NOT EXISTS idx_waypoints_dst ON {w}(dst_id);
CREATE INDEX IF NOT EXISTS idx_stats_ts ON {s}(ts);
CREATE INDEX IF NOT EXISTS idx_temporal_subject ON {tf}(subject);
CREATE INDEX IF NOT EXISTS idx_temporal_facts_user ON {tf}(user_id);
CREATE INDEX IF NOT EXISTS idx_temporal_edges_user ON {te}(user_id);