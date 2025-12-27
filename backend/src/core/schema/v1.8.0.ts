import { Migration } from "./migration_types";

export const v1_8_0: Migration = {
    version: "1.8.0",
    desc: "Add optional pgvector column for faster similarity search and index",
    sqlite: [
        // no-op for sqlite: pgvector is Postgres-only
    ],
    postgres: [
        `CREATE EXTENSION IF NOT EXISTS vector`,
        `DO $$ BEGIN
            ALTER TABLE {v} ADD COLUMN IF NOT EXISTS v_vector vector;
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Could not add v_vector column: %', SQLERRM;
        END $$;`,
        `DO $$ BEGIN
            CREATE INDEX IF NOT EXISTS openmemory_vectors_vvector_idx ON {v} USING ivfflat (v_vector vector_l2_ops) WITH (lists = 100);
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Could not create ivfflat index (maybe pgvector not configured): %', SQLERRM;
        END $$;`,
    ],
};
