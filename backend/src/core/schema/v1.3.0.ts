import { Migration } from "./migration_types";

export const v1_3_0: Migration = {
    version: "1.3.0",
    desc: "Temporal memory support",
    sqlite: [
        `CREATE TABLE IF NOT EXISTS temporal_facts(id TEXT PRIMARY KEY, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER, confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1), last_updated INTEGER NOT NULL, metadata TEXT, UNIQUE(subject, predicate, object, valid_from))`,
        `CREATE TABLE IF NOT EXISTS temporal_edges(id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation_type TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER, weight REAL NOT NULL, metadata TEXT, FOREIGN KEY(source_id) REFERENCES temporal_facts(id), FOREIGN KEY(target_id) REFERENCES temporal_facts(id))`,
        `CREATE INDEX IF NOT EXISTS idx_temporal_subject ON temporal_facts(subject)`,
        `CREATE INDEX IF NOT EXISTS idx_temporal_predicate ON temporal_facts(predicate)`,
        `CREATE INDEX IF NOT EXISTS idx_temporal_validity ON temporal_facts(valid_from, valid_to)`,
        `CREATE INDEX IF NOT EXISTS idx_temporal_composite ON temporal_facts(subject, predicate, valid_from, valid_to)`,
        `CREATE INDEX IF NOT EXISTS idx_edges_source ON temporal_edges(source_id)`,
        `CREATE INDEX IF NOT EXISTS idx_edges_target ON temporal_edges(target_id)`,
        `CREATE INDEX IF NOT EXISTS idx_edges_validity ON temporal_edges(valid_from, valid_to)`,
    ],
    postgres: [
        `CREATE TABLE IF NOT EXISTS {tf} (id TEXT PRIMARY KEY, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL, valid_from BIGINT NOT NULL, valid_to BIGINT, confidence DOUBLE PRECISION NOT NULL CHECK(confidence >= 0 AND confidence <= 1), last_updated BIGINT NOT NULL, metadata TEXT, UNIQUE(subject, predicate, object, valid_from))`,
        `CREATE TABLE IF NOT EXISTS {te} (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation_type TEXT NOT NULL, valid_from BIGINT NOT NULL, valid_to BIGINT, weight DOUBLE PRECISION NOT NULL, metadata TEXT, FOREIGN KEY(source_id) REFERENCES {tf}(id), FOREIGN KEY(target_id) REFERENCES {tf}(id))`,
        `CREATE INDEX IF NOT EXISTS openmemory_temporal_subject_idx ON {tf}(subject)`,
        `CREATE INDEX IF NOT EXISTS openmemory_temporal_predicate_idx ON {tf}(predicate)`,
        `CREATE INDEX IF NOT EXISTS openmemory_temporal_validity_idx ON {tf}(valid_from, valid_to)`,
        `CREATE INDEX IF NOT EXISTS openmemory_edges_source_idx ON {te}(source_id)`,
        `CREATE INDEX IF NOT EXISTS openmemory_edges_target_idx ON {te}(target_id)`,
    ],
};
