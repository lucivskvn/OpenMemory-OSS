import { beforeAll } from "bun:test";
import { run_async } from "../src/core/db";

const SCHEMA_TABLES = [
    `create table if not exists memories(id text primary key,user_id text,project_id text,segment integer default 0,content text not null,summary text,simhash text,primary_sector text not null,tags text,meta text,created_at integer,updated_at integer,last_seen_at integer,salience real,decay_lambda real,version integer default 1,mean_dim integer,mean_vec blob,compressed_vec blob,feedback_score real default 0,coactivations integer default 0)`,
    `create table if not exists vectors(id text not null,project_id text,sector text not null,user_id text,v blob not null,dim integer not null,primary key(id,sector))`,
    `create table if not exists openmemory_vectors(id text not null,project_id text,sector text not null,user_id text,v blob not null,dim integer not null,primary key(id,sector))`,
    `create table if not exists waypoints(src_id text,dst_id text not null,user_id text,project_id text,weight real not null,created_at integer,updated_at integer,primary key(src_id,user_id))`,
    `create table if not exists embed_logs(id text primary key,model text,status text,ts integer,err text)`,
    `create table if not exists users(user_id text primary key,summary text,reflection_count integer default 0,created_at integer,updated_at integer)`,
    `create table if not exists stats(id integer primary key autoincrement,type text not null,count integer default 1,ts integer not null)`,
    `create table if not exists temporal_facts(id text primary key,user_id text,project_id text,subject text not null,predicate text not null,object text not null,valid_from integer not null,valid_to integer,confidence real not null check(confidence >= 0 and confidence <= 1),last_updated integer not null,metadata text,unique(subject,predicate,object,valid_from))`,
    `create table if not exists temporal_edges(id text primary key,source_id text not null,target_id text not null,relation_type text not null,valid_from integer not null,valid_to integer,weight real not null,metadata text,foreign key(source_id) references temporal_facts(id),foreign key(target_id) references temporal_facts(id))`,
];

beforeAll(async () => {
    try {
        console.log("Setting up DB tables for test...");
        for (const sql of SCHEMA_TABLES) {
            await run_async(sql);
        }
        console.log("DB setup complete");
    } catch (e) {
        console.error("Test setup DB init failed", e);
    }
});
