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

-- Check if v_vector has explicit typmod (dimension) and if there are rows that need backfill
DO $$ DECLARE tmod int; BEGIN
    SELECT atttypmod INTO tmod FROM pg_attribute WHERE attrelid = 'openmemory_vectors'::regclass AND attname = 'v_vector';
    IF tmod IS NULL OR tmod = 0 THEN
        RAISE NOTICE 'v_vector column has no explicit dimension (atttypmod=%). Run tools/backfill_pgvector.ts to populate v_vector and then set dimension via ALTER TABLE to vector(N).', tmod;
    END IF;
    IF EXISTS (SELECT 1 FROM openmemory_vectors WHERE v IS NOT NULL AND v_vector IS NULL) THEN
        RAISE NOTICE 'There are rows with bytea "v" that require backfill into "v_vector". Use tools/backfill_pgvector.ts to fill v_vector from v, then re-run finalization to set dimension and create ivfflat index.';
    END IF;
END $$;
