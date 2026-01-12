-- 012_performance_boost.sql
-- Optimizing common query patterns for history, deduplication, and graph traversal.

-- Index for history() and getAll() - essential for dashboard performance
CREATE INDEX IF NOT EXISTS idx_memories_user_created ON {m}(user_id, created_at DESC);

-- Index for deduplication during add()
CREATE INDEX IF NOT EXISTS idx_memories_user_simhash ON {m}(user_id, simhash);

-- Indexes for graph expansion in hsg.py and temporal_graph
CREATE INDEX IF NOT EXISTS idx_waypoints_user_src ON {w}(user_id, src_id);
CREATE INDEX IF NOT EXISTS idx_waypoints_user_dst ON {w}(user_id, dst_id);

-- Index for predicate-based timeline queries
CREATE INDEX IF NOT EXISTS idx_temporal_facts_user_pred ON {tf}(user_id, predicate);

-- Index for object-based fact queries
CREATE INDEX IF NOT EXISTS idx_temporal_facts_user_obj ON {tf}(user_id, object);
