import sqlite3
import os
import time
import json
from openmemory.core.cfg import env
from threading import Lock
from openmemory.core.vector_store import SQLiteVectorStore

db = None
db_lock = Lock()
vector_store = None
tx_depth = 0

def init_db(custom_path=None):
    global db
    if db:
        return

    db_path = custom_path or env["db_path"] or "./data/openmemory.sqlite"
    if db_path != ":memory:":
        directory = os.path.dirname(db_path)
        if directory and not os.path.exists(directory):
            os.makedirs(directory, exist_ok=True)

    db = sqlite3.connect(db_path, check_same_thread=False)
    db.row_factory = sqlite3.Row
    
    with db_lock:
        cur = db.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA temp_store=MEMORY")
        cur.execute("PRAGMA cache_size=-8000")
        cur.execute("PRAGMA mmap_size=134217728")
        # Enforce foreign key constraints for data integrity (temporal_edges -> temporal_facts)
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA wal_autocheckpoint=20000")
        cur.execute("PRAGMA locking_mode=NORMAL")
        cur.execute("PRAGMA busy_timeout=5000")

        cur.execute("""
            create table if not exists memories(id text primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,created_at integer,updated_at integer,last_seen_at integer,salience real,decay_lambda real,version integer default 1,mean_dim integer,mean_vec blob,compressed_vec blob,feedback_score real default 0)
        """)
        cur.execute("""
            create table if not exists vectors(id text not null,sector text not null,user_id text,v blob not null,dim integer not null,primary key(id,sector))
        """)
        cur.execute("""
            create table if not exists waypoints(src_id text,dst_id text not null,user_id text,weight real not null,created_at integer,updated_at integer,primary key(src_id,dst_id,user_id))
        """)
        cur.execute("""
            create table if not exists embed_logs(id text primary key,model text,status text,ts integer,err text)
        """)
        cur.execute("""
            create table if not exists users(user_id text primary key,summary text,reflection_count integer default 0,created_at integer,updated_at integer)
        """)
        cur.execute("""
            create table if not exists stats(id integer primary key autoincrement,type text not null,count integer default 1,ts integer not null)
        """)
        cur.execute("""
            create table if not exists temporal_facts(id text primary key,subject text not null,predicate text not null,object text not null,valid_from integer not null,valid_to integer,confidence real not null check(confidence >= 0 and confidence <= 1),last_updated integer not null,metadata text,unique(subject,predicate,object,valid_from))
        """)
        cur.execute("""
            create table if not exists temporal_edges(id text primary key,source_id text not null,target_id text not null,relation_type text not null,valid_from integer not null,valid_to integer,weight real not null,metadata text,foreign key(source_id) references temporal_facts(id),foreign key(target_id) references temporal_facts(id))
        """)

        # Indices
        indices = [
            "create index if not exists idx_memories_sector on memories(primary_sector)",
            "create index if not exists idx_memories_segment on memories(segment)",
            "create index if not exists idx_memories_simhash on memories(simhash)",
            "create index if not exists idx_memories_ts on memories(last_seen_at)",
            "create index if not exists idx_memories_user on memories(user_id)",
            "create index if not exists idx_vectors_user on vectors(user_id)",
            "create index if not exists idx_waypoints_src on waypoints(src_id)",
            "create index if not exists idx_waypoints_dst on waypoints(dst_id)",
            "create index if not exists idx_waypoints_user on waypoints(user_id)",
            "create index if not exists idx_stats_ts on stats(ts)",
            "create index if not exists idx_stats_type on stats(type)",
            "create index if not exists idx_temporal_subject on temporal_facts(subject)",
            "create index if not exists idx_temporal_predicate on temporal_facts(predicate)",
            "create index if not exists idx_temporal_validity on temporal_facts(valid_from,valid_to)",
            "create index if not exists idx_temporal_composite on temporal_facts(subject,predicate,valid_from,valid_to)",
            "create index if not exists idx_edges_source on temporal_edges(source_id)",
            "create index if not exists idx_edges_target on temporal_edges(target_id)",
            "create index if not exists idx_edges_validity on temporal_edges(valid_from,valid_to)",
        ]
        for idx in indices:
            cur.execute(idx)
        
        db.commit()
        
        global vector_store
        vector_store = SQLiteVectorStore({
            'exec': exec_query,
            'one': one_query,
            'many': many_query
        }, "vectors")
        
def close_db():
    global db
    if db:
        with db_lock:
            db.close()
            db = None

class TransactionManager:
    def __enter__(self):
        global tx_depth
        if not db:
            raise Exception("DB not initialized")
        with db_lock:
            if tx_depth == 0:
                db.execute("BEGIN TRANSACTION")
            tx_depth += 1
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        global tx_depth
        if not db:
            return
        with db_lock:
            if tx_depth > 0:
                tx_depth -= 1

            if tx_depth == 0:
                if exc_type:
                    db.execute("ROLLBACK")
                else:
                    db.execute("COMMIT")

transaction = TransactionManager()

def exec_query(sql, params=()):
    if not db:
        raise Exception("DB not initialized")
    with db_lock:
        cur = db.cursor()
        cur.execute(sql, params)
        # Only commit if not in a transaction block
        if tx_depth == 0:
            db.commit()

def one_query(sql, params=()):
    if not db:
        raise Exception("DB not initialized")
    with db_lock:
        cur = db.cursor()
        cur.execute(sql, params)
        row = cur.fetchone()
        return dict(row) if row else None

def many_query(sql, params=()):
    if not db:
        raise Exception("DB not initialized")
    with db_lock:
        cur = db.cursor()
        cur.execute(sql, params)
        rows = cur.fetchall()
        return [dict(row) for row in rows]

class Q:
    class ins_mem:
        @staticmethod
        def run(*p):
            exec_query("insert into memories(id,user_id,segment,content,simhash,primary_sector,tags,meta,created_at,updated_at,last_seen_at,salience,decay_lambda,version,mean_dim,mean_vec,compressed_vec,feedback_score) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", p)
    
    class upd_mean_vec:
        @staticmethod
        def run(*p):
            exec_query("update memories set mean_dim=?,mean_vec=? where id=?", p)

    class upd_compressed_vec:
        @staticmethod
        def run(*p):
            exec_query("update memories set compressed_vec=? where id=?", p)

    class create_single_waypoint: # This was missing in the JS dump but used in index.ts, likely ins_waypoint
        pass

    class ins_waypoint:
        @staticmethod
        def run(*p):
            exec_query("insert or replace into waypoints(src_id,dst_id,user_id,weight,created_at,updated_at) values(?,?,?,?,?,?)", p)

    class del_mem:
        @staticmethod
        def run(*p):
            exec_query("delete from memories where id=?", p)

    class del_waypoints:
        @staticmethod
        def run(*p):
            exec_query("delete from waypoints where src_id=? or dst_id=?", p)

    class all_mem:
        @staticmethod
        def all(limit, offset):
            return many_query("select * from memories order by created_at desc limit ? offset ?", (limit, offset))

    class all_mem_by_sector:
        @staticmethod
        def all(sector, limit, offset):
            return many_query("select * from memories where primary_sector=? order by created_at desc limit ? offset ?", (sector, limit, offset))

    class all_mem_by_user:
        @staticmethod
        def all(user_id, limit, offset):
            return many_query("select * from memories where user_id=? order by created_at desc limit ? offset ?", (user_id, limit, offset))

    class get_user:
        @staticmethod
        def get(user_id):
            return one_query("select * from users where user_id=?", (user_id,))

    class get_mem:
        @staticmethod
        def get(id):
            return one_query("select * from memories where id=?", (id,))

    class get_mem_by_simhash:
        @staticmethod
        def get(simhash):
            return one_query("select * from memories where simhash=? order by salience desc limit 1", (simhash,))

    class get_max_segment:
        @staticmethod
        def get():
            return one_query("select coalesce(max(segment), 0) as max_seg from memories")

    class get_segment_count:
        @staticmethod
        def get(segment):
            return one_query("select count(*) as c from memories where segment=?", (segment,))

    class get_mems_by_ids:
        @staticmethod
        def all(ids):
            if not ids:
                return []
            ph = ",".join(["?"] * len(ids))
            return many_query(f"select * from memories where id in ({ph})", ids)

    class ins_fact:
        @staticmethod
        def run(*p):
            exec_query("insert or replace into temporal_facts(id,subject,predicate,object,valid_from,valid_to,confidence,last_updated,metadata) values(?,?,?,?,?,?,?,?,?)", p)

    class get_facts:
        @staticmethod
        def all(f):
            sql = "select * from temporal_facts where 1=1"
            params = []
            if f.get('subject'):
                sql += " and subject=?"
                params.append(f['subject'])
            if f.get('predicate'):
                sql += " and predicate=?"
                params.append(f['predicate'])
            if f.get('object'):
                sql += " and object=?"
                params.append(f['object'])
            if f.get('valid_at'):
                sql += " and valid_from <= ? and (valid_to is null or valid_to >= ?)"
                params.append(f['valid_at'])
                params.append(f['valid_at'])
            sql += " order by valid_from desc"
            return many_query(sql, tuple(params))

    class inv_fact:
        @staticmethod
        def run(id, valid_to):
            exec_query("update temporal_facts set valid_to=?, last_updated=? where id=?", (valid_to, int(time.time()*1000), id))

    class ins_edge:
        @staticmethod
        def run(*p):
            exec_query("insert or replace into temporal_edges(id,source_id,target_id,relation_type,valid_from,valid_to,weight,metadata) values(?,?,?,?,?,?,?,?)", p)

    class get_edges:
        @staticmethod
        def all(source_id):
            return many_query("select * from temporal_edges where source_id=?", (source_id,))

    class upd_seen:
        @staticmethod
        def run(*p):
            exec_query("update memories set last_seen_at=?,salience=?,updated_at=? where id=?", p)

q = Q
