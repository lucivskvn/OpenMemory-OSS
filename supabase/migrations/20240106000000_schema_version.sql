-- Create schema_version tracking table and insert current version
CREATE TABLE IF NOT EXISTS schema_version (
  version TEXT PRIMARY KEY,
  applied_at BIGINT
);

INSERT INTO schema_version (version, applied_at)
VALUES ('1.7.0', (EXTRACT(EPOCH FROM now()) * 1000)::bigint)
ON CONFLICT (version) DO UPDATE SET applied_at = EXCLUDED.applied_at;