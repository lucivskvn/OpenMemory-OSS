-- Optional: Add a pgvector column and index for faster similarity search
CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
    ALTER TABLE openmemory_vectors ADD COLUMN IF NOT EXISTS v_vector vector;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Could not add v_vector column: %', SQLERRM;
END $$;

DO $$ BEGIN
    CREATE INDEX IF NOT EXISTS openmemory_vectors_vvector_idx ON openmemory_vectors USING ivfflat (v_vector vector_l2_ops) WITH (lists = 100);
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Could not create ivfflat index (maybe pgvector not configured): %', SQLERRM;
END $$;
