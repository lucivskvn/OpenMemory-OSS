-- 004_stats_sync.sql
CREATE TABLE IF NOT EXISTS stats_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    count INTEGER DEFAULT 1,
    ts INTEGER NOT NULL
);
-- Try to migrate existing basic stats if any
INSERT INTO stats_new (type, count, ts)
SELECT 'legacy_metric',
    1,
    ts
FROM stats
WHERE metrics IS NOT NULL;
DROP TABLE stats;
ALTER TABLE stats_new
    RENAME TO stats;
CREATE INDEX IF NOT EXISTS idx_stats_ts ON stats(ts);
CREATE INDEX IF NOT EXISTS idx_stats_type ON stats(type);