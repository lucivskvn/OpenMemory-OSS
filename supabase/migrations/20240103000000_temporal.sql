-- Temporal memory support
CREATE TABLE IF NOT EXISTS temporal_facts (id TEXT PRIMARY KEY, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL, valid_from BIGINT NOT NULL, valid_to BIGINT, confidence DOUBLE PRECISION NOT NULL CHECK(confidence >= 0 AND confidence <= 1), last_updated BIGINT NOT NULL, metadata TEXT, UNIQUE(subject, predicate, object, valid_from));
CREATE TABLE IF NOT EXISTS temporal_edges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation_type TEXT NOT NULL, valid_from BIGINT NOT NULL, valid_to BIGINT, weight DOUBLE PRECISION NOT NULL, metadata TEXT, FOREIGN KEY(source_id) REFERENCES temporal_facts(id), FOREIGN KEY(target_id) REFERENCES temporal_facts(id));
CREATE INDEX IF NOT EXISTS openmemory_temporal_subject_idx ON temporal_facts(subject);
CREATE INDEX IF NOT EXISTS openmemory_temporal_predicate_idx ON temporal_facts(predicate);
CREATE INDEX IF NOT EXISTS openmemory_temporal_validity_idx ON temporal_facts(valid_from, valid_to);
CREATE INDEX IF NOT EXISTS openmemory_edges_source_idx ON temporal_edges(source_id);
CREATE INDEX IF NOT EXISTS openmemory_edges_target_idx ON temporal_edges(target_id);
