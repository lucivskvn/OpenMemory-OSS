-- 011_parity_tables.sql
-- Create missing tables for parity with JS SDK

CREATE TABLE IF NOT EXISTS {ak} (
    key_hash TEXT PRIMARY KEY,
    user_id TEXT,
    role TEXT DEFAULT 'user',
    note TEXT,
    created_at INTEGER,
    last_used INTEGER,
    status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS {soc} (
    type TEXT PRIMARY KEY,
    config TEXT,
    status TEXT DEFAULT 'enabled',
    updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS {ml} (
    id TEXT PRIMARY KEY,
    type TEXT,
    status TEXT,
    ts INTEGER,
    details TEXT
);
