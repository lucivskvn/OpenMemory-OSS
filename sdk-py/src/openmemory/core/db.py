import sqlite3
import threading
import json
import os
import time
from typing import Optional, Dict, Any, List
from openmemory.core.vector_store import SqlVectorStore

db_local = threading.local()
db_path = os.getenv("OM_DB_PATH", os.path.join(os.getcwd(), "openmemory.sqlite"))
db_lock = threading.Lock()

q = None
transaction = None
vector_store = None

# Ensure directory exists
os.makedirs(os.path.dirname(db_path), exist_ok=True)

def get_db():
    if not hasattr(db_local, "conn"):
        db_local.conn = sqlite3.connect(db_path, check_same_thread=False)
        db_local.conn.row_factory = sqlite3.Row
        # PRAGMAs for performance and consistency
        db_local.conn.execute("PRAGMA journal_mode=WAL")
        db_local.conn.execute("PRAGMA synchronous=NORMAL")
        db_local.conn.execute("PRAGMA foreign_keys=ON")
    return db_local.conn

def exec_query(sql: str, params: tuple = ()) -> None:
    with db_lock:
        conn = get_db()
        conn.execute(sql, params)
        if not getattr(db_local, "in_transaction", False):
            conn.commit()

def fetch_one(sql: str, params: tuple = ()) -> Optional[Dict[str, Any]]:
    conn = get_db()
    cur = conn.execute(sql, params)
    row = cur.fetchone()
    return dict(row) if row else None

def fetch_all(sql: str, params: tuple = ()) -> List[Dict[str, Any]]:
    conn = get_db()
    cur = conn.execute(sql, params)
    return [dict(row) for row in cur.fetchall()]

# Transaction Manager
class TransactionManager:
    def __init__(self):
        pass

    async def begin(self):
        if not getattr(db_local, "in_transaction", False):
            with db_lock:
                get_db().execute("BEGIN TRANSACTION")
                db_local.in_transaction = True

    async def commit(self):
        if getattr(db_local, "in_transaction", False):
            with db_lock:
                get_db().commit()
                db_local.in_transaction = False

    async def rollback(self):
        if getattr(db_local, "in_transaction", False):
            with db_lock:
                get_db().execute("ROLLBACK")
                db_local.in_transaction = False

transaction = TransactionManager()

def init_db():
    global vector_store, q
    
    # Schemas matching backend v1.9.0 logic
    schemas = [
        "create table if not exists memories(id text primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,created_at integer,updated_at integer,last_seen_at integer,salience real,decay_lambda real,version integer default 1,mean_dim integer,mean_vec blob,compressed_vec blob,feedback_score real default 0)",
        "create table if not exists vectors(id text not null,sector text not null,user_id text,v blob not null,dim integer not null,primary key(id,sector))",
        "create table if not exists waypoints(src_id text,dst_id text not null,user_id text,weight real not null,created_at integer,updated_at integer,primary key(src_id,dst_id,user_id))",
        "create table if not exists embed_logs(id text primary key,model text,status text,ts integer,err text)",
        "create table if not exists users(user_id text primary key,summary text,reflection_count integer default 0,created_at integer,updated_at integer)",
        "create table if not exists stats(id integer primary key autoincrement,type text not null,count integer default 1,ts integer not null)",
        "create table if not exists temporal_facts(id text primary key,subject text not null,predicate text not null,object text not null,valid_from integer not null,valid_to integer,confidence real not null check(confidence >= 0 and confidence <= 1),last_updated integer not null,metadata text,unique(subject,predicate,object,valid_from))",
        "create table if not exists temporal_edges(id text primary key,source_id text not null,target_id text not null,relation_type text not null,valid_from integer not null,valid_to integer,weight real not null,metadata text,foreign key(source_id) references temporal_facts(id),foreign key(target_id) references temporal_facts(id))",
        "create index if not exists idx_memories_sector on memories(primary_sector)",
        "create index if not exists idx_memories_segment on memories(segment)",
        "create index if not exists idx_memories_simhash on memories(simhash)",
        "create index if not exists idx_memories_ts on memories(last_seen_at)",
        "create index if not exists idx_memories_created_at on memories(created_at)",
        "create index if not exists idx_memories_user on memories(user_id)",
        "create index if not exists idx_vectors_user on vectors(user_id)",
        "create index if not exists idx_vectors_sector on vectors(sector)",
        "create index if not exists idx_waypoints_src on waypoints(src_id)",
        "create index if not exists idx_waypoints_dst on waypoints(dst_id)",
        "create index if not exists idx_waypoints_user on waypoints(user_id)",
        "create index if not exists idx_waypoints_src_user on waypoints(src_id,user_id)",
    ]

    with db_lock:
        conn = get_db()
        for sql in schemas:
            try:
                conn.execute(sql)
            except Exception as e:
                pass
        conn.commit()

    # Initialize components with sync DB wrappers
    vector_store = SqlVectorStore({
        "exec": exec_query,
        "one": fetch_one,
        "many": fetch_all
    }, "vectors")

    # Q implementation placeholder - for SDK local mode usually minimal
    # In a real scenario, we'd port the QueryRepository class here.
    # For now ensuring vector_store availability is the priority task.

# Auto-init
init_db()
