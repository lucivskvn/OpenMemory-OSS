-- Fix waypoint primary key and add missing indexes for multi-tenant isolation (v1.7.0)

-- Drop old constraint and add new composite primary key
ALTER TABLE openmemory_waypoints DROP CONSTRAINT IF EXISTS waypoints_pkey;
ALTER TABLE openmemory_waypoints DROP CONSTRAINT IF EXISTS openmemory_waypoints_pkey;
ALTER TABLE openmemory_waypoints ADD PRIMARY KEY (src_id, dst_id, user_id);

-- Add missing indexes for better query performance
CREATE INDEX IF NOT EXISTS openmemory_waypoints_src_idx ON openmemory_waypoints(src_id);
CREATE INDEX IF NOT EXISTS openmemory_waypoints_dst_idx ON openmemory_waypoints(dst_id);
CREATE INDEX IF NOT EXISTS openmemory_waypoints_user_idx ON openmemory_waypoints(user_id);
CREATE INDEX IF NOT EXISTS openmemory_waypoints_src_user_idx ON openmemory_waypoints(src_id, user_id);
