import { Migration } from "./migration_types";

export const v1_4_0: Migration = {
    version: "1.4.0",
    desc: "Performance optimization indices",
    sqlite: [
        `CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_vectors_sector ON vectors(sector)`,
    ],
    postgres: [
        `CREATE INDEX IF NOT EXISTS openmemory_memories_created_at_idx ON {m}(created_at)`,
        `CREATE INDEX IF NOT EXISTS openmemory_vectors_sector_idx ON {v}(sector)`,
    ],
};
