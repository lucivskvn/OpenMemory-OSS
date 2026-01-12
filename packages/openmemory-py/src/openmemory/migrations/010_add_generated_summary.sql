-- 010_add_generated_summary.sql
-- Add generated_summary column to memories table
-- Some existing installations might have `summary` column if they used older versions, but we standardize on generated_summary

ALTER TABLE {m} ADD COLUMN generated_summary TEXT;
