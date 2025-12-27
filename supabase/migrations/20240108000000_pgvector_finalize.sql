-- Finalize pgvector setup: set explicit dimension and create index where possible
DO $$ BEGIN
    -- Attempt to set explicit dimension (match env.vec_dim or default 256).
    ALTER TABLE openmemory_vectors ALTER COLUMN v_vector TYPE vector(256) USING v_vector::vector;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Could not set v_vector dimension: %', SQLERRM;
END $$;

DO $$ BEGIN
    CREATE INDEX IF NOT EXISTS openmemory_vectors_vvector_ivfflat_idx ON openmemory_vectors USING ivfflat (v_vector vector_l2_ops) WITH (lists = 100);
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Could not create ivfflat index (finalize): %', SQLERRM;
END $$;
