-- 007_performance_indexes.sql
-- Add composite indexes for user-scoped performance optimization (Parity with JS)

CREATE INDEX IF NOT EXISTS idx_memories_user_sector ON {m}(user_id, primary_sector);
CREATE INDEX IF NOT EXISTS idx_memories_user_ts ON {m}(user_id, last_seen_at);

CREATE INDEX IF NOT EXISTS idx_temporal_user_subject ON {tf}(user_id, subject);
CREATE INDEX IF NOT EXISTS idx_temporal_user_edges ON {te}(user_id, source_id, target_id);
CREATE INDEX IF NOT EXISTS idx_temporal_validity ON {tf}(valid_from, valid_to);

CREATE INDEX IF NOT EXISTS idx_edges_source ON {te}(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON {te}(target_id);
