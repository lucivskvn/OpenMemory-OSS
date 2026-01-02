-- 002_temporal_user_id.sql
ALTER TABLE temporal_facts
ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_temporal_facts_user ON temporal_facts(user_id);
ALTER TABLE temporal_edges
ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_temporal_edges_user ON temporal_edges(user_id);