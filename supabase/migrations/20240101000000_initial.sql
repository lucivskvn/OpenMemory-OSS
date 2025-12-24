-- Initial Schema (Postgres)
create table if not exists openmemory_memories(id uuid primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,created_at bigint,updated_at bigint,last_seen_at bigint,salience double precision,decay_lambda double precision,version integer default 1,mean_dim integer,mean_vec bytea,compressed_vec bytea,feedback_score double precision default 0);
create table if not exists openmemory_vectors(id uuid,sector text,user_id text,v bytea,dim integer not null,primary key(id,sector));
create table if not exists openmemory_waypoints(src_id text,dst_id text not null,user_id text,weight double precision not null,created_at bigint,updated_at bigint,primary key(src_id,user_id));
create table if not exists openmemory_embed_logs(id text primary key,model text,status text,ts bigint,err text);
create table if not exists openmemory_users(user_id text primary key,summary text,reflection_count integer default 0,created_at bigint,updated_at bigint);
create table if not exists stats(id serial primary key,type text not null,count integer default 1,ts bigint not null);
create table if not exists temporal_facts(id text primary key,subject text not null,predicate text not null,object text not null,valid_from bigint not null,valid_to bigint,confidence double precision not null check(confidence >= 0 and confidence <= 1),last_updated bigint not null,metadata text,unique(subject,predicate,object,valid_from));
create table if not exists temporal_edges(id text primary key,source_id text not null,target_id text not null,relation_type text not null,valid_from bigint not null,valid_to bigint,weight double precision not null,metadata text,foreign key(source_id) references temporal_facts(id),foreign key(target_id) references temporal_facts(id));

create index if not exists openmemory_memories_sector_idx on openmemory_memories(primary_sector);
create index if not exists openmemory_memories_segment_idx on openmemory_memories(segment);
create index if not exists openmemory_memories_simhash_idx on openmemory_memories(simhash);
create index if not exists openmemory_memories_created_at_idx on openmemory_memories(created_at);
create index if not exists openmemory_memories_user_idx on openmemory_memories(user_id);
create index if not exists openmemory_vectors_user_idx on openmemory_vectors(user_id);
create index if not exists openmemory_vectors_sector_idx on openmemory_vectors(sector);
create index if not exists openmemory_waypoints_user_idx on openmemory_waypoints(user_id);
create index if not exists openmemory_stats_ts_idx on stats(ts);
create index if not exists openmemory_stats_type_idx on stats(type);
create index if not exists openmemory_temporal_subject_idx on temporal_facts(subject);
create index if not exists openmemory_temporal_predicate_idx on temporal_facts(predicate);
create index if not exists openmemory_temporal_validity_idx on temporal_facts(valid_from,valid_to);
create index if not exists openmemory_edges_source_idx on temporal_edges(source_id);
create index if not exists openmemory_edges_target_idx on temporal_edges(target_id);
