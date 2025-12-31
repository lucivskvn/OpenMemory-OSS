import { Migration } from "./migration_types";

export const v1_9_0: Migration = {
    version: "1.9.0",
    desc: "Ensure vector table exists with proper dimension for SQLite/PG consistency",
    sqlite: [
        // Ensure table exists if not already (redundant with initial schema but good for safety)
        `CREATE TABLE IF NOT EXISTS vectors(id text not null,sector text not null,user_id text,v blob not null,dim integer not null,primary key(id,sector))`,
        `CREATE INDEX IF NOT EXISTS idx_vectors_user ON vectors(user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_vectors_sector ON vectors(sector)`,
    ],
    postgres: [
        // Ensure v_vector has correct dimension if null
        // This is a soft migration to alert admins or try to fix if possible
        `DO $$ DECLARE
            tmod int;
            target_dim int := ${process.env.OM_VEC_DIM || 1536};
        BEGIN
            -- Check if v_vector exists
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'openmemory_vectors' AND column_name = 'v_vector') THEN
                SELECT atttypmod INTO tmod FROM pg_attribute WHERE attrelid = 'openmemory_vectors'::regclass AND attname = 'v_vector';
                IF tmod IS NULL OR tmod <= 0 THEN
                    RAISE NOTICE 'v_vector column exists but has no dimension. Attempting to set to %', target_dim;
                    BEGIN
                        EXECUTE format('ALTER TABLE openmemory_vectors ALTER COLUMN v_vector TYPE vector(%s) USING v_vector::vector(%s)', target_dim, target_dim);
                    EXCEPTION WHEN OTHERS THEN
                        RAISE NOTICE 'Could not automatically set dimension: %', SQLERRM;
                    END;
                END IF;
            END IF;
        END $$;`
    ],
};
