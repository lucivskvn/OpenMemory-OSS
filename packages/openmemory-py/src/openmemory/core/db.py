import sqlite3
import asyncio
import time
import json
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional, Union
from contextlib import asynccontextmanager
import contextvars
from .config import env
from .types import MemRow

# Thread-local/Task-local storage for transactions
_tx_conn = contextvars.ContextVar("_tx_conn", default=None)

# simple logger
logger = logging.getLogger("db")
logger.setLevel(logging.INFO)

class DB:
    def __init__(self):
        self.conn: Optional[Union[sqlite3.Connection, Any]] = None
        self._pool: Optional[Any] = None
        url = env.database_url or ""
        self.is_pg = url.startswith("postgresql://") or url.startswith("postgres://")
        self._current_url = None
        self._current_url = None
        self._lock = asyncio.Lock() # Lock for SQLite
        self._tx_lock = asyncio.Lock()
        self._stmt_cache: Dict[str, Any] = {}

    async def disconnect(self):
        """Close the database connection/pool."""
        if self._pool:
             await asyncio.to_thread(self._pool.closeall)
             self._pool = None
             
        if self.conn:
            if self.is_pg:
                await asyncio.to_thread(self.conn.close)
            else: # SQLite
                self.conn.close()
            self.conn = None
            self._stmt_cache.clear()
            logger.info("Database disconnected")

    def close(self):
        """Synchronous close helper used by tests."""
        if self.conn:
            try:
                self.conn.close()
            except Exception:
                pass
            self.conn = None

    def connect(self, force: bool = False):
        # Parse connection string
        url = env.database_url

        # If already connected to the SAME url, skip
        if self.conn and not force:
            # We don't easily know the current URL if we didn't store it
            # Let's store it
            if hasattr(self, "_current_url") and self._current_url == url:
                # Ensure lock is valid for current loop
                if self._lock is None: self._lock = asyncio.Lock()
                return

        # Re-init locks for new connection/loop context
        self._lock = asyncio.Lock()
        self._tx_lock = asyncio.Lock()

        self._current_url = url
        if url.startswith("sqlite:///"):
            self.is_pg = False
            path = Path(url.replace("sqlite:///", ""))
            if not path.parent.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
            logger.info(f"[DB] Connecting to {path}")
            self.conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
            self.conn.row_factory = sqlite3.Row

            # Pragma tuning for SQLite
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA synchronous=NORMAL")
            self.conn.execute("PRAGMA cache_size=-8000")
            self.conn.execute("PRAGMA foreign_keys=ON")
        elif url.startswith("postgresql://") or url.startswith("postgres://"):
            try:
                import psycopg2
                from psycopg2 import pool
                from psycopg2.extras import DictCursor
            except ImportError:
                raise ImportError("PostgreSQL support requires 'psycopg2-binary'. Install it via pip.")

            self.is_pg = True
            logger.info(f"[DB] Connecting to PostgreSQL (Pooled)")
            if not self._pool:
                # Basic pool settings
                self._pool = pool.ThreadedConnectionPool(1, env.max_threads or 20, url)
            self.conn = self._pool.getconn()
            self.conn.autocommit = True
        else:
            raise ValueError(f"Unsupported database URL schema: {url}. Only sqlite:/// and postgresql:// are supported.")

        self.run_migrations()

    def run_migrations(self):
        if not self.conn:
            return
        c = self.conn
        # Ensure migrations table
        c.execute("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER)")

        # Load migration files
        files = []
        try:
            from importlib import resources
            # list files in openmemory.migrations (python 3.9+)
            files = [p.name for p in resources.files('openmemory.migrations').iterdir() if p.name.endswith(".sql")]
        except (ImportError, TypeError, AttributeError):
            import os
            mig_path = Path(__file__).parent.parent / "migrations"
            if mig_path.exists():
                files = [f for f in os.listdir(mig_path) if f.endswith(".sql")]

        files.sort()

        for f in files:
            if not self.fetchone("SELECT 1 FROM _migrations WHERE name=?", (f,)):
                logger.info(f"[DB] Applying migration {f}")
                try:
                    sql = None
                    try:
                        from importlib import resources
                        sql = resources.files('openmemory.migrations').joinpath(f).read_text(encoding='utf-8')
                    except Exception:
                        pass
                    if not sql:
                        sql = (Path(__file__).parent.parent / "migrations" / f).read_text(encoding="utf-8")

                    # Apply Table Replacements (Parity with JS SDK)
                    sc = env.pg_schema
                    mt = env.pg_table
                    
                    if self.is_pg:
                        replacements = {
                            "{m}": f'"{sc}"."{mt}"',
                            "{v}": f'"{sc}"."{mt}_vectors"',
                            "{w}": f'"{sc}"."{mt}_waypoints"',
                            "{u}": f'"{sc}"."{env.users_table or "openmemory_users"}"',
                            "{s}": f'"{sc}"."{mt}_stats"',
                            "{tf}": f'"{sc}"."{mt}_temporal_facts"',
                            "{te}": f'"{sc}"."{mt}_temporal_edges"',
                            "{el}": f'"{sc}"."{mt}_embed_logs"',
                            "{lm}": f'"{sc}"."{mt}_learned_models"',
                            "{sc}": f'"{sc}"',
                            "{ak}": f'"{sc}"."{mt}_api_keys"',
                            "{soc}": f'"{sc}"."{mt}_source_configs"',
                            "{ml}": f'"{sc}"."{mt}_maint_logs"',
                        }
                    else:
                        replacements = {
                            "{m}": "memories",
                            "{v}": env.vector_table or "vectors",
                            "{w}": "waypoints",
                            "{u}": "users",
                            "{s}": "stats",
                            "{tf}": "temporal_facts",
                            "{te}": "temporal_edges",
                            "{el}": "embed_logs",
                            "{lm}": "learned_models",
                            "{sc}": "",
                            "{ak}": "api_keys",
                            "{soc}": "source_configs",
                            "{ml}": "maint_logs",
                        }

                    for k, v in replacements.items():
                        sql = sql.replace(k, v)

                    # Execute script - SQLite has executescript, but Postgres requires manual split or simple execute if it supports multiple stmts
                    if self.is_pg:
                        cur = c.cursor()
                        # psycopg2 can execute multiple statements at once usually, but better to be safe
                        cur.execute(sql)
                    else:
                        c.executescript(sql)
                    
                    c.execute("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)", (f, int(time.time())))
                except Exception as e:
                    msg = str(e).lower()
                    if "duplicate column" in msg or "already exists" in msg or "duplicate key" in msg:
                        logger.warning(f"[DB] Migration {f} skipped (duplicate/exists): {e}")
                        c.execute("INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)", (f, int(time.time())))
                    else:
                        logger.error(f"[DB] Migration {f} failed: {e}")
                        raise e

    def init_schema(self):
        """Legacy entry point, mapped to migrations."""
        self.run_migrations()

    def get_conn(self):
        """Get a connection from the pool (if PG) or return the main one."""
        tx = _tx_conn.get()
        if tx: return tx
        
        if self.is_pg and self._pool:
            return self._pool.getconn()
        return self.conn

    def release_conn(self, conn):
        """Release a connection back to the pool."""
        if _tx_conn.get() == conn:
            return # Don't release if in transaction
            
        if self.is_pg and self._pool:
            try:
                self._pool.putconn(conn)
            except Exception as e:
                logger.error(f"[DB] Error releasing connection: {e}")

    def execute(self, sql: str, params: tuple = ()) -> Any:
        self.connect()
        conn = self.get_conn()
        if not conn:
            raise RuntimeError("Database connection not established")
        
        try:
            if self.is_pg:
                # Map ? to %s for psycopg2
                sql = sql.replace("?", "%s")
                from psycopg2.extras import RealDictCursor
                cur = conn.cursor(cursor_factory=RealDictCursor)
                cur.execute(sql, params)
                return cur
                
            # SQLite
            return conn.execute(sql, params)
        finally:
            self.release_conn(conn)

    def _fetch_to_dict(self, row):
        if not row: return None
        if self.is_pg:
            # psycopg2 cursors can return tuple or dict depending on factory
            # but standard is tuple. However, we want consistency.
            # If we used DictCursor it might be easier.
            return row
        return dict(row)

    def fetchall(self, sql: str, params: tuple = ()) -> List[Any]:
        self.connect()
        cur = self.execute(sql, params)
        rows = cur.fetchall()
        return [dict(r) for r in rows]

    def fetchone(self, sql: str, params: tuple = ()) -> Optional[Any]:
        self.connect()
        cur = self.execute(sql, params)
        row = cur.fetchone()
        return dict(row) if row else None

    async def async_execute(self, sql: str, params: tuple = ()) -> Any:
        if self.is_pg:
            return await asyncio.to_thread(self.execute, sql, params)
        async with self._lock:
            return await asyncio.to_thread(self.execute, sql, params)

    async def async_fetchone(self, sql: str, params: tuple = ()) -> Optional[Any]:
        if self.is_pg:
            return await asyncio.to_thread(self.fetchone, sql, params)
        async with self._lock:
            return await asyncio.to_thread(self.fetchone, sql, params)

    async def async_fetchall(self, sql: str, params: tuple = ()) -> List[Any]:
        if self.is_pg:
             return await asyncio.to_thread(self.fetchall, sql, params)
        async with self._lock:
             return await asyncio.to_thread(self.fetchall, sql, params)

    def executemany(self, sql: str, params_list: List[tuple]) -> Any:
        self.connect()
        conn = self.get_conn()
        if not conn: raise RuntimeError("Database connection not established")
        try:
            if self.is_pg:
                # Optimized batch for PG? psycopg2 extras.execute_values is better but executemany is standard.
                sql = sql.replace("?", "%s")
                cur = conn.cursor()
                cur.executemany(sql, params_list)
                return cur
            return conn.executemany(sql, params_list)
        finally:
            self.release_conn(conn)

    async def async_executemany(self, sql: str, params_list: List[tuple]) -> Any:
        if self.is_pg:
            return await asyncio.to_thread(self.executemany, sql, params_list)
        async with self._lock:
            return await asyncio.to_thread(self.executemany, sql, params_list)

    def commit(self):
        if self.conn and not self.is_pg: self.conn.commit()
        if self.conn and self.is_pg: self.conn.commit()

    async def async_commit(self):
        await asyncio.to_thread(self.commit)

    def rollback(self):
        if self.conn: self.conn.rollback()

    async def async_rollback(self):
        await asyncio.to_thread(self.rollback)

    @asynccontextmanager
    async def transaction(self):
        """Async context manager for transactions."""
        conn = self.conn
        if not conn:
            self.connect()
            conn = self.conn

        await self.async_execute("BEGIN")
        try:
            yield
            await self.async_commit()
        except Exception as e:
            await self.async_rollback()
            raise e

# Single global instance
db = DB()

# Specific query wrappers matching q_type
class Queries:
    def __init__(self):
        self._cache = {} # Simple in-memory cache for frequent lookups
    @property
    def tables(self) -> Dict[str, str]:
        # Dynamic table resolution based on current DB state and config
        is_pg = db.is_pg
        sc = env.pg_schema
        # Default table base
        mt = env.pg_table
        
        if is_pg:
            return {
                "memories": f'"{sc}"."{mt}"',
                "vectors": f'"{sc}"."{mt}_vectors"',
                "waypoints": f'"{sc}"."{mt}_waypoints"',
                "users": f'"{sc}"."{env.users_table or "openmemory_users"}"',
                "stats": f'"{sc}"."{mt}_stats"',
                "temporal_facts": f'"{sc}"."{mt}_temporal_facts"',
                "temporal_edges": f'"{sc}"."{mt}_temporal_edges"',
                "embed_logs": f'"{sc}"."{mt}_embed_logs"',
                "learned_models": f'"{sc}"."{mt}_learned_models"',
                "maint_logs": f'"{sc}"."{mt}_maint_logs"',
                "source_configs": f'"{sc}"."{mt}_source_configs"',
                "api_keys": f'"{sc}"."{mt}_api_keys"',
                "pg_schema": f'"{sc}"'
            }
        else:
            return {
                "memories": "memories",
                "vectors": env.vector_table or "vectors",
                "waypoints": "waypoints",
                "users": "users",
                "stats": "stats",
                "temporal_facts": "temporal_facts",
                "temporal_edges": "temporal_edges",
                "embed_logs": "embed_logs",
                "learned_models": "learned_models",
                "maint_logs": "maint_logs",
                "source_configs": "source_configs",
                "api_keys": "api_keys",
                "pg_schema": ""
            }

    async def ins_mem(self, **k):
        t = self.tables
        sql = f"""
        INSERT INTO {t['memories']}(id, user_id, segment, content, simhash, primary_sector, tags, metadata, created_at, updated_at, last_seen_at, salience, decay_lambda, version, mean_dim, mean_vec, compressed_vec, feedback_score, generated_summary)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
        user_id=excluded.user_id, segment=excluded.segment, content=excluded.content, simhash=excluded.simhash, primary_sector=excluded.primary_sector,
        tags=excluded.tags, metadata=excluded.metadata, created_at=excluded.created_at, updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at,
        salience=excluded.salience, decay_lambda=excluded.decay_lambda, version=excluded.version, mean_dim=excluded.mean_dim,
        mean_vec=excluded.mean_vec, compressed_vec=excluded.compressed_vec, feedback_score=excluded.feedback_score, generated_summary=excluded.generated_summary
        """
        
        # Helper to stringify complex types (Sustainability/Consistency)
        meta = k.get("metadata") or k.get("meta")
        if isinstance(meta, (dict, list)): meta = json.dumps(meta)
        
        tags = k.get("tags")
        if isinstance(tags, (list, tuple)): tags = json.dumps(tags)
        
        vals = (
            k.get("id"), k.get("user_id"), k.get("segment", 0), k.get("content"), k.get("simhash"),
            k.get("primary_sector"), tags, meta, k.get("created_at"), k.get("updated_at"),
            k.get("last_seen_at"), k.get("salience", 1.0), k.get("decay_lambda", 0.02), k.get("version", 1),
            k.get("mean_dim"), k.get("mean_vec"), k.get("compressed_vec"), k.get("feedback_score", 0),
            k.get("generated_summary")
        )
        await db.async_execute(sql, vals)
        if k.get("commit", True): await db.async_commit()

    async def upd_mean_vec(self, mid: str, dim: int, vec: bytes, user_id: Optional[str] = None, commit: bool = True):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (dim, vec, mid) + ((user_id,) if user_id else ())
        await db.async_execute(f"UPDATE {t['memories']} SET mean_dim=?, mean_vec=? WHERE id=? {user_clause}", params)
        if commit: await db.async_commit()

    async def upd_compressed_vec(self, mid: str, vec: bytes, user_id: Optional[str] = None, commit: bool = True):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (vec, mid) + ((user_id,) if user_id else ())
        await db.async_execute(f"UPDATE {t['memories']} SET compressed_vec=? WHERE id=? {user_clause}", params)
        if commit: await db.async_commit()

    async def upd_feedback(self, mid: str, score: float, user_id: Optional[str] = None, commit: bool = True):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (score, mid) + ((user_id,) if user_id else ())
        await db.async_execute(f"UPDATE {t['memories']} SET feedback_score=? WHERE id=? {user_clause}", params)
        if commit: await db.async_commit()

    async def upd_seen(self, mid: str, last_seen: int, salience: float, updated: int, user_id: Optional[str] = None, commit: bool = True):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (last_seen, salience, updated, mid) + ((user_id,) if user_id else ())
        await db.async_execute(f"UPDATE {t['memories']} SET last_seen_at=?, salience=?, updated_at=? WHERE id=? {user_clause}", params)
        if commit: await db.async_commit()

    async def upd_mem(self, mid: str, content: str, tags: str, metadata: str, updated: int, user_id: Optional[str] = None, commit: bool = True):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (content, tags, metadata, updated, mid) + ((user_id,) if user_id else ())
        await db.async_execute(f"UPDATE {t['memories']} SET content=?, tags=?, metadata=?, updated_at=?, version=version+1 WHERE id=? {user_clause}", params)
        if commit: await db.async_commit()

    async def upd_mem_with_sector(self, mid: str, content: str, sector: str, tags: str, metadata: str, updated: int, user_id: Optional[str] = None, commit: bool = True):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (content, sector, tags, metadata, updated, mid) + ((user_id,) if user_id else ())
        await db.async_execute(f"UPDATE {t['memories']} SET content=?, primary_sector=?, tags=?, metadata=?, updated_at=?, version=version+1 WHERE id=? {user_clause}", params)
        if commit: await db.async_commit()

    async def upd_mem_salience(self, mid: str, salience: float, user_id: Optional[str] = None, commit: bool = True):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (salience, int(time.time()*1000), mid) + ((user_id,) if user_id else ())
        await db.async_execute(f"UPDATE {t['memories']} SET salience=?, updated_at=? WHERE id=? {user_clause}", params)
        if commit: await db.async_commit()

    async def get_mem(self, mid: str, user_id: Optional[str] = None):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (mid,) + ((user_id,) if user_id else ())
        return await db.async_fetchone(f"SELECT * FROM {t['memories']} WHERE id=? {user_clause}", params)

    async def get_mem_by_simhash(self, simhash: str, user_id: Optional[str] = None):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else "AND 1=1"
        params = (simhash,) + ((user_id,) if user_id else ())
        return await db.async_fetchone(f"SELECT * FROM {t['memories']} WHERE simhash=? {user_clause} ORDER BY salience DESC LIMIT 1", params)

    async def get_mems_by_ids(self, ids: List[str], user_id: Optional[str] = None):
        if not ids: return []
        t = self.tables
        placeholders = ",".join(["?"] * len(ids))
        user_clause = "AND user_id=?" if user_id else ""
        params = tuple(ids) + ((user_id,) if user_id else ())
        return await db.async_fetchall(f"SELECT * FROM {t['memories']} WHERE id IN ({placeholders}) {user_clause}", params)

    async def all_mem(self, limit=10, offset=0, user_id: Optional[str] = None):
        """
        Fetch all memories, strictly isolated by user_id. 
        Defaults to 'anonymous' if no user_id is provided to prevent accidental data leaks.
        """
        t = self.tables
        # CRITICAL: Default to anonymous to prevent 'SELECT *' without filter
        uid = user_id or "anonymous"
        user_clause = "WHERE user_id=?"
        params = (uid, limit, offset)
        return await db.async_fetchall(f"SELECT * FROM {t['memories']} {user_clause} ORDER BY created_at DESC LIMIT ? OFFSET ?", params)

    async def all_mem_by_sector(self, sector: str, limit=10, offset=0, user_id: Optional[str] = None):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (sector,) + ((user_id,) if user_id else ()) + (limit, offset)
        return await db.async_fetchall(f"SELECT * FROM {t['memories']} WHERE primary_sector=? {user_clause} ORDER BY created_at DESC LIMIT ? OFFSET ?", params)

    async def ins_log(self, id: str, model: str, status: str, ts: int, err: Optional[str] = None, user_id: Optional[str] = None, commit: bool = True):
        t = self.tables
        await db.async_execute(f"INSERT INTO {t['embed_logs']}(id, model, status, ts, err, user_id) VALUES (?,?,?,?,?,?)", (id, model, status, ts, err, user_id))
        if commit: await db.async_commit()

    async def upd_log(self, id: str, status: str, err: Optional[str] = None, user_id: Optional[str] = None, commit: bool = True):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (status, err, id) + ((user_id,) if user_id else ())
        await db.async_execute(f"UPDATE {t['embed_logs']} SET status=?, err=? WHERE id=? {user_clause}", params)
        if commit: await db.async_commit()

    async def all_mem_by_user(self, user_id: str, limit=10, offset=0):
        t = self.tables
        return await db.async_fetchall(f"SELECT * FROM {t['memories']} WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?", (user_id, limit, offset))

    async def get_active_users(self) -> List[Dict]:
        t = self.tables
        # Internal admin-only helper. 
        # In multi-tenant mode, this would be highly restricted or scoped.
        return await db.async_fetchall(f"SELECT DISTINCT user_id FROM {t['memories']} WHERE user_id IS NOT NULL")

    async def get_segment_count(self, segment: int, user_id: Optional[str] = None):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (segment,) + ((user_id,) if user_id else ())
        return await db.async_fetchone(f"SELECT COUNT(*) as c FROM {t['memories']} WHERE segment=? {user_clause}", params)

    async def get_max_segment(self, user_id: Optional[str] = None):
        t = self.tables
        user_clause = "WHERE user_id=?" if user_id else ""
        params = ((user_id,) if user_id else ())
        return await db.async_fetchone(f"SELECT COALESCE(MAX(segment), 0) as max_seg FROM {t['memories']} {user_clause}", params)

    async def get_segments(self, user_id: Optional[str] = None):
        t = self.tables
        user_clause = "WHERE user_id=?" if user_id else ""
        params = ((user_id,) if user_id else ())
        return await db.async_fetchall(f"SELECT DISTINCT segment FROM {t['memories']} {user_clause} ORDER BY segment DESC", params)

    async def get_mem_by_segment(self, segment: int, user_id: Optional[str] = None):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (segment,) + ((user_id,) if user_id else ())
        return await db.async_fetchall(f"SELECT * FROM {t['memories']} WHERE segment=? {user_clause} ORDER BY created_at DESC", params)

    async def ins_waypoint(self, src: str, dst: str, uid: Optional[str], wt: float, created: int, updated: int, commit: bool = True):
        t = self.tables
        # Ensure non-null user_id for conflict resolution
        final_uid = uid or "anonymous"
        sql = f"""
        INSERT INTO {t['waypoints']} (src_id, dst_id, user_id, weight, created_at, updated_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(src_id, dst_id, user_id) DO UPDATE SET weight=excluded.weight, updated_at=excluded.updated_at
        """
        await db.async_execute(sql, (src, dst, final_uid, wt, created, updated))
        if commit: await db.async_commit()

    async def get_neighbors(self, src_id: str, user_id: Optional[str] = None):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (src_id,) + ((user_id,) if user_id else ())
        return await db.async_fetchall(f"SELECT dst_id, weight FROM {t['waypoints']} WHERE src_id=? {user_clause} ORDER BY weight DESC", params)

    async def get_waypoints_by_src(self, src_id: str, user_id: Optional[str] = None):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (src_id,) + ((user_id,) if user_id else ())
        return await db.async_fetchall(f"SELECT * FROM {t['waypoints']} WHERE src_id=? {user_clause}", params)

    async def get_waypoint(self, src: str, dst: str, user_id: Optional[str] = None):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (src, dst) + ((user_id,) if user_id else ())
        return await db.async_fetchone(f"SELECT weight FROM {t['waypoints']} WHERE src_id=? AND dst_id=? {user_clause}", params)

    async def upd_waypoint(self, src: str, wt: float, updated: int, dst: str, user_id: Optional[str] = None, commit: bool = True):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (wt, updated, src, dst) + ((user_id,) if user_id else ())
        await db.async_execute(f"UPDATE {t['waypoints']} SET weight=?, updated_at=? WHERE src_id=? AND dst_id=? {user_clause}", params)
        if commit: await db.async_commit()

    async def del_waypoints(self, mid: str, user_id: Optional[str] = None, commit: bool = True):
        t = self.tables
        user_clause = ""
        if user_id:
             user_clause = "AND user_id=?"
             params = (mid, mid, user_id)
        else:
             params = (mid, mid)
             
        await db.async_execute(f"DELETE FROM {t['waypoints']} WHERE (src_id=? OR dst_id=?) {user_clause}", params)
        if commit: await db.async_commit()

    async def prune_waypoints(self, threshold: float, user_id: Optional[str] = None, commit: bool = True):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (threshold,) + ((user_id,) if user_id else ())
        await db.async_execute(f"DELETE FROM {t['waypoints']} WHERE weight < ? {user_clause}", params)
        if commit: await db.async_commit()

    async def get_pending_logs(self, user_id: Optional[str] = None):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = ("pending",) + ((user_id,) if user_id else ())
        return await db.async_fetchall(f"SELECT * FROM {t['embed_logs']} WHERE status=? {user_clause}", params)

    async def get_failed_logs(self, user_id: Optional[str] = None):
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = ("failed",) + ((user_id,) if user_id else ())
        return await db.async_fetchall(f"SELECT * FROM {t['embed_logs']} WHERE status=? {user_clause} ORDER BY ts DESC LIMIT 100", params)

    async def get_sector_stats(self, user_id: Optional[str] = None):
        t = self.tables
        user_clause = "WHERE user_id = ?" if user_id else "WHERE user_id IS NULL OR user_id='anonymous'"
        params = (user_id,) if user_id else ()
        return await db.async_fetchall(f"SELECT primary_sector as sector, count(*) as count, avg(salience) as avg_salience FROM {t['memories']} {user_clause} GROUP BY primary_sector", params)

    async def get_tables(self):
        t = self.tables
        if db.is_pg:
            # We want actual table names from info schema, filtered by our schema
            schema_name = env.pg_schema or 'public'
            # Note: The query should target the schema defined in config, not hardcoded 'public'
            return await db.async_fetchall(f"SELECT table_name as name FROM information_schema.tables WHERE table_schema = '{schema_name}'")
        else:
            return await db.async_fetchall("SELECT name FROM sqlite_master WHERE type='table'")

    async def ins_user(self, uid: str, summary: str, reflection_count: int, created: int, updated: int, metadata: Optional[Union[str, Dict, List]] = None, commit: bool = True):
        t = self.tables
        
        # Robust metadata handling
        if isinstance(metadata, (dict, list)): metadata = json.dumps(metadata)
            
        await db.async_execute(f"INSERT OR IGNORE INTO {t['users']} (user_id, summary, reflection_count, created_at, updated_at, metadata) VALUES (?,?,?,?,?,?)", (uid, summary, reflection_count, created, updated, metadata))
        if commit: await db.async_commit()

    async def get_user(self, uid: str):
        # Cache check
        cache_key = f"user:{uid}"
        if cache_key in self._cache:
            entry = self._cache[cache_key]
            if time.time() - entry["ts"] < 30: # 30s cache
                return entry["data"]

        t = self.tables
        res = await db.async_fetchone(f"SELECT * FROM {t['users']} WHERE user_id=?", (uid,))
        if res:
             # Prevent unbounded growth
            if len(self._cache) > 2000: self._cache.clear()
            self._cache[cache_key] = {"data": res, "ts": time.time()}
        return res

    async def upd_user_summary(self, uid: str, summary: str, updated: int, commit: bool = True):
        t = self.tables
        await db.async_execute(f"UPDATE {t['users']} SET summary=?, reflection_count=reflection_count+1, updated_at=? WHERE user_id=?", (summary, updated, uid))
        if commit: await db.async_commit()

    async def get_classifier_model(self, user_id: str):
        t = self.tables
        return await db.async_fetchone(f"SELECT * FROM {t['learned_models']} WHERE user_id=?", (user_id,))

    async def ins_classifier_model(self, user_id: str, weights: str, biases: str, version: int, updated_at: int, commit: bool = True):
        t = self.tables
        sql = f"INSERT INTO {t['learned_models']}(user_id, weights, biases, version, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET weights=excluded.weights, biases=excluded.biases, version=excluded.version, updated_at=excluded.updated_at"
        await db.async_execute(sql, (user_id, weights, biases, version, updated_at))
        if commit: await db.async_commit()

    async def get_training_data(self, user_id: str, limit: int = 1000):
        t = self.tables
        return await db.async_fetchall(f"SELECT primary_sector, mean_vec FROM {t['memories']} WHERE user_id=? AND mean_vec IS NOT NULL LIMIT ?", (user_id, limit))

    async def get_stats(self, user_id: Optional[str] = None) -> List[Dict[str, Any]]:
        t = self.tables
        cond = "WHERE user_id = ?" if user_id else ""
        params = (user_id,) if user_id else ()
        sql = f"SELECT primary_sector, COUNT(*) as count FROM {t['memories']} {cond} GROUP BY primary_sector"
        return await db.async_fetchall(sql, params)

    async def get_api_key(self, key_hash: str):
        # Cache check
        cache_key = f"apikey:{key_hash}"
        if cache_key in self._cache:
            entry = self._cache[cache_key]
            if time.time() - entry["ts"] < 60: # 1 min cache for API keys
                return entry["data"]

        t = self.tables
        res = await db.async_fetchone(f"SELECT * FROM {t['api_keys']} WHERE key_hash=?", (key_hash,))
        if res:
            self._cache[cache_key] = {"data": res, "ts": time.time()}
        return res

    async def list_api_keys(self):
        t = self.tables
        return await db.async_fetchall(f"SELECT * FROM {t['api_keys']}")

    async def revoke_api_key(self, key_hash: str, commit: bool = True):
        t = self.tables
        await db.async_execute(f"DELETE FROM {t['api_keys']} WHERE key_hash=?", (key_hash,))
        if commit: await db.async_commit()

    async def clear_all(self, commit: bool = True):
        t = self.tables
        for k, v in t.items():
            if k == 'pg_schema': continue
            try:
                await db.async_execute(f"DELETE FROM {v}")
            except Exception:
                pass # Ignore if table doesn't exist or other error during wipe
        if commit: await db.async_commit()

    async def del_mem(self, mid: str, user_id: Optional[str] = None, commit: bool = True):
        """
        Delete a memory and its associated vectors/waypoints.
        """
        t = self.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (mid,) + ((user_id,) if user_id else ())
        
        # Hardened: Ensure we delete ONLY if user_id matches (if provided)
        # We need to verify existence first if user_id is set to properly cascade?
        # Actually, standard SQL DELETE WHERE user_id=? works fine.
        
        # 1. Delete Vectors (Cascading manually as we can't trust FKs on all valid SQLite versions/configs)
        # We must delete vectors where id matches the memory being deleted.
        # If user_id is provided, we must ensure that 'mid' actually belongs to 'user_id' before nuking vectors.
        if user_id:
             # Check ownership first
             exists = await db.async_fetchone(f"SELECT 1 FROM {t['memories']} WHERE id=? {user_clause}", params)
             if not exists: return # Nothing to delete or not owned by user
        
        await db.async_execute(f"DELETE FROM {t['vectors']} WHERE id=?", (mid,))
        
        # 2. Delete Waypoints (Source or Dest)
        await db.async_execute(f"DELETE FROM {t['waypoints']} WHERE src_id=? OR dst_id=?", (mid, mid))
        
        # 3. Delete Memory
        await db.async_execute(f"DELETE FROM {t['memories']} WHERE id=? {user_clause}", params)
        
        if commit: await db.async_commit()


    async def del_mem_by_user(self, uid: str, commit: bool = True):
        t = self.tables
        # Note: Subqueries in DELETE are standard SQL
        await db.async_execute(f"DELETE FROM {t['vectors']} WHERE id IN (SELECT id FROM {t['memories']} WHERE user_id=?)", (uid,))
        await db.async_execute(f"DELETE FROM {t['waypoints']} WHERE src_id IN (SELECT id FROM {t['memories']} WHERE user_id=?) OR dst_id IN (SELECT id FROM {t['memories']} WHERE user_id=?)", (uid, uid))
        await db.async_execute(f"DELETE FROM {t['temporal_facts']} WHERE user_id=?", (uid,))
        await db.async_execute(f"DELETE FROM {t['temporal_edges']} WHERE user_id=?", (uid,))
        await db.async_execute(f"DELETE FROM {t['memories']} WHERE user_id=?", (uid,))
        if commit: await db.async_commit()

async def log_maint_op(m_type: str, count: int = 1):
    try:
        t = q.tables # Need to access tables via instance
        await db.async_execute(f"INSERT INTO {t['stats']} (type, count, ts) VALUES (?, ?, ?)", (m_type, count, int(time.time() * 1000)))
        await db.async_commit()
    except Exception as e:
        logger.error(f"[DB] Maintenance log error: {e}")

q = Queries()


@asynccontextmanager
async def transaction():
    await asyncio.to_thread(db.connect)
    
    # Serialize transactions locally to prevent "cannot start a transaction within a transaction"
    # Only lock for SQLite to prevent interleaved transactions on shared connection
    # For Postgres, each context gets a unique connection from pool, so parallel tx is safe.
    if db.is_pg:
         conn = db.get_conn()
         token = _tx_conn.set(conn)
         try:
            await db.async_execute("BEGIN")
            yield conn
            await db.async_commit()
         except Exception as e:
            await db.async_rollback()
            raise e
         finally:
            _tx_conn.reset(token)
            db.release_conn(conn)
    else:
        async with db._tx_lock:
            conn = db.get_conn()
            token = _tx_conn.set(conn)
            started = False
            try:
                # Check for existing transaction state (if supported) or try/except BEGIN
                try:
                    await db.async_execute("BEGIN")
                    started = True
                except Exception as e:
                    # SQLite raises OperationalError if transaction is active
                    if "transaction" in str(e).lower():
                        pass # Already in transaction, proceed in nested scope
                    else:
                        raise e
                
                yield conn
                
                if started:
                    await db.async_commit()
            except Exception as e:
                # Only rollback if we started it or if it's a critical fatal error?
                # If nested, effectively we trigger rollback of outer if exception propagates?
                # But we can't rollback if we didn't start.
                if started:
                    await db.async_rollback()
                raise e
            finally:
                _tx_conn.reset(token)
                db.release_conn(conn)
