-- 004_stats_sync.sql
CREATE TABLE IF NOT EXISTS {s}_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    count INTEGER DEFAULT 1,
    ts INTEGER NOT NULL
);
-- Try to migrate existing basic stats if any
INSERT INTO {s}_new (type, count, ts)
SELECT 'legacy_metric',
    1,
    ts
FROM {s}
WHERE metrics IS NOT NULL;
DROP TABLE {s};
ALTER TABLE {s}_new
    RENAME TO {s};
CREATE INDEX IF NOT EXISTS idx_stats_ts ON {s}(ts);
CREATE INDEX IF NOT EXISTS idx_stats_type ON {s}(type);