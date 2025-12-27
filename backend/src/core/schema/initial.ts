export interface DbOps {
    run_async: (sql: string, params?: any[]) => Promise<void>;
    get_async: (sql: string, params?: any[]) => Promise<any>;
    all_async: (sql: string, params?: any[]) => Promise<any[]>;
    is_pg: boolean;
}

export const get_initial_schema_sqlite = (vector_table: string) => [
    `create table if not exists memories(id text primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,created_at integer,updated_at integer,last_seen_at integer,salience real,decay_lambda real,version integer default 1,mean_dim integer,mean_vec blob,compressed_vec blob,feedback_score real default 0)`,
    `create table if not exists ${vector_table}(id text not null,sector text not null,user_id text,v blob not null,dim integer not null,primary key(id,sector))`,
    `create table if not exists waypoints(src_id text,dst_id text not null,user_id text,weight real not null,created_at integer,updated_at integer,primary key(src_id,dst_id,user_id))`,
    `create table if not exists embed_logs(id text primary key,model text,status text,ts integer,err text)`,
    `create table if not exists users(user_id text primary key,summary text,reflection_count integer default 0,created_at integer,updated_at integer)`,
    `create table if not exists stats(id integer primary key autoincrement,type text not null,count integer default 1,ts integer not null)`,
    `create table if not exists temporal_facts(id text primary key,subject text not null,predicate text not null,object text not null,valid_from integer not null,valid_to integer,confidence real not null check(confidence >= 0 and confidence <= 1),last_updated integer not null,metadata text,unique(subject,predicate,object,valid_from))`,
    `create table if not exists temporal_edges(id text primary key,source_id text not null,target_id text not null,relation_type text not null,valid_from integer not null,valid_to integer,weight real not null,metadata text,foreign key(source_id) references temporal_facts(id),foreign key(target_id) references temporal_facts(id))`,
    "create index if not exists idx_memories_sector on memories(primary_sector)",
    "create index if not exists idx_memories_segment on memories(segment)",
    "create index if not exists idx_memories_simhash on memories(simhash)",
    "create index if not exists idx_memories_ts on memories(last_seen_at)",
    "create index if not exists idx_memories_created_at on memories(created_at)",
    "create index if not exists idx_memories_user on memories(user_id)",
    `create index if not exists idx_vectors_user on ${vector_table}(user_id)`,
    `create index if not exists idx_vectors_sector on ${vector_table}(sector)`,
    "create index if not exists idx_waypoints_src on waypoints(src_id)",
    "create index if not exists idx_waypoints_dst on waypoints(dst_id)",
    "create index if not exists idx_waypoints_user on waypoints(user_id)",
    "create index if not exists idx_waypoints_src_user on waypoints(src_id,user_id)",
    "create index if not exists idx_stats_ts on stats(ts)",
    "create index if not exists idx_stats_type on stats(type)",
    "create index if not exists idx_temporal_subject on temporal_facts(subject)",
    "create index if not exists idx_temporal_predicate on temporal_facts(predicate)",
    "create index if not exists idx_temporal_validity on temporal_facts(valid_from,valid_to)",
    "create index if not exists idx_temporal_composite on temporal_facts(subject,predicate,valid_from,valid_to)",
    "create index if not exists idx_edges_source on temporal_edges(source_id)",
    "create index if not exists idx_edges_target on temporal_edges(target_id)",
    "create index if not exists idx_edges_validity on temporal_edges(valid_from,valid_to)",
];

export const get_initial_schema_pg = (tables: { m: string; v: string; w: string; l: string; u: string; s: string; tf: string; te: string }) => [
    `create table if not exists ${tables.m}(id uuid primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,created_at bigint,updated_at bigint,last_seen_at bigint,salience double precision,decay_lambda double precision,version integer default 1,mean_dim integer,mean_vec bytea,compressed_vec bytea,feedback_score double precision default 0)`,
    `create table if not exists ${tables.v}(id uuid,sector text,user_id text,v bytea,dim integer not null,primary key(id,sector))`,
    `create table if not exists ${tables.w}(src_id text,dst_id text not null,user_id text,weight double precision not null,created_at bigint,updated_at bigint,primary key(src_id,dst_id,user_id))`,
    `create table if not exists ${tables.l}(id text primary key,model text,status text,ts bigint,err text)`,
    `create table if not exists ${tables.u}(user_id text primary key,summary text,reflection_count integer default 0,created_at bigint,updated_at bigint)`,
    `create table if not exists ${tables.s}(id serial primary key,type text not null,count integer default 1,ts bigint not null)`,
    // Temporal tables
    `create table if not exists ${tables.tf}(id text primary key,subject text not null,predicate text not null,object text not null,valid_from bigint not null,valid_to bigint,confidence double precision not null check(confidence >= 0 and confidence <= 1),last_updated bigint not null,metadata text,unique(subject,predicate,object,valid_from))`,
    `create table if not exists ${tables.te}(id text primary key,source_id text not null,target_id text not null,relation_type text not null,valid_from bigint not null,valid_to bigint,weight double precision not null,metadata text,foreign key(source_id) references ${tables.tf}(id),foreign key(target_id) references ${tables.tf}(id))`,

    `create index if not exists openmemory_memories_sector_idx on ${tables.m}(primary_sector)`,
    `create index if not exists openmemory_memories_segment_idx on ${tables.m}(segment)`,
    `create index if not exists openmemory_memories_simhash_idx on ${tables.m}(simhash)`,
    `create index if not exists openmemory_memories_created_at_idx on ${tables.m}(created_at)`,
    `create index if not exists openmemory_memories_user_idx on ${tables.m}(user_id)`,
    `create index if not exists openmemory_vectors_user_idx on ${tables.v}(user_id)`,
    `create index if not exists openmemory_vectors_sector_idx on ${tables.v}(sector)`,
    `create index if not exists openmemory_waypoints_src_idx on ${tables.w}(src_id)`,
    `create index if not exists openmemory_waypoints_dst_idx on ${tables.w}(dst_id)`,
    `create index if not exists openmemory_waypoints_user_idx on ${tables.w}(user_id)`,
    `create index if not exists openmemory_waypoints_src_user_idx on ${tables.w}(src_id,user_id)`,
    `create index if not exists openmemory_stats_ts_idx on ${tables.s}(ts)`,
    `create index if not exists openmemory_stats_type_idx on ${tables.s}(type)`,
    `create index if not exists openmemory_temporal_subject_idx on ${tables.tf}(subject)`,
    `create index if not exists openmemory_temporal_predicate_idx on ${tables.tf}(predicate)`,
    `create index if not exists openmemory_temporal_validity_idx on ${tables.tf}(valid_from,valid_to)`,
    `create index if not exists openmemory_edges_source_idx on ${tables.te}(source_id)`,
    `create index if not exists openmemory_edges_target_idx on ${tables.te}(target_id)`,
];
