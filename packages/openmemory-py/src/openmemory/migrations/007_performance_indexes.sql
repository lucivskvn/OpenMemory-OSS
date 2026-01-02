-- 007_performance_indexes.sql
-- Add composite indexes for user-scoped performance optimization (Parity with JS)

CREATE INDEX IF NOT EXISTS idx_memories_user_sector ON memories(user_id, primary_sector);
CREATE INDEX IF NOT EXISTS idx_memories_user_ts ON memories(user_id, last_seen_at);

CREATE INDEX IF NOT EXISTS idx_temporal_user_subject ON temporal_facts(user_id, subject);
CREATE INDEX IF NOT EXISTS idx_temporal_user_edges ON temporal_edges(user_id, source_id, target_id);
CREATE INDEX IF NOT EXISTS idx_temporal_validity ON temporal_facts(valid_from, valid_to);

CREATE INDEX IF NOT EXISTS idx_edges_source ON temporal_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON temporal_edges(target_id);
