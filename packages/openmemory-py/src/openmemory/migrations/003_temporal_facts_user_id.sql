-- 003_temporal_facts_user_id.sql
ALTER TABLE temporal_facts ADD COLUMN user_id TEXT;
ALTER TABLE temporal_facts ADD COLUMN last_updated INTEGER;
ALTER TABLE temporal_facts RENAME COLUMN obj TO object;
