import { Migration } from "./migration_types";

export const v1_6_0: Migration = {
    version: "1.6.0",
    desc: "Optimize temporal edges query",
    sqlite: [
        `CREATE INDEX IF NOT EXISTS idx_edges_source_weight ON temporal_edges(source_id, weight)`,
    ],
    postgres: [
        `CREATE INDEX IF NOT EXISTS openmemory_edges_source_weight_idx ON {te}(source_id, weight)`,
    ],
};
