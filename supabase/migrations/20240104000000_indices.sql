-- Performance optimization indices
CREATE INDEX IF NOT EXISTS openmemory_memories_created_at_idx ON openmemory_memories(created_at);
CREATE INDEX IF NOT EXISTS openmemory_vectors_sector_idx ON openmemory_vectors(sector);
