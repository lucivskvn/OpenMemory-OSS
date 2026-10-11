-- Align temporal_facts with the store layer: rename obj -> object and add
-- user_id / last_updated so fact mutations can be tenant-scoped.

PRAGMA foreign_keys=OFF;

CREATE TABLE temporal_facts_new (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    valid_from INTEGER NOT NULL,
    valid_to INTEGER,
    confidence REAL,
    last_updated INTEGER,
    metadata TEXT
);

INSERT INTO temporal_facts_new (id, subject, predicate, object, valid_from, valid_to, confidence, metadata)
SELECT id, subject, predicate, obj, valid_from, valid_to, confidence, metadata FROM temporal_facts;

DROP TABLE temporal_facts;
ALTER TABLE temporal_facts_new RENAME TO temporal_facts;

CREATE INDEX IF NOT EXISTS idx_temporal_subject ON temporal_facts(subject);
CREATE INDEX IF NOT EXISTS idx_temporal_user ON temporal_facts(user_id);

PRAGMA foreign_keys=ON;
