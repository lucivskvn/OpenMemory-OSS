import sqlite3
import asyncio
import time
import json
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional, Union
from .config import env
from .types import MemRow

# simple logger
logger = logging.getLogger("db")
logger.setLevel(logging.INFO)

class DB:
    def __init__(self):
        self.conn: Optional[Union[sqlite3.Connection, Any]] = None
        self.is_pg = False
        self._current_url = None
        self._lock = None

    async def disconnect(self):
        """Close the database connection/pool."""
        if self.conn:
            if self.is_pg:
                # For psycopg2, conn.close() is synchronous, wrap in to_thread
                await asyncio.to_thread(self.conn.close)
            else: # SQLite
                self.conn.close()
            self.conn = None
            logger.info("Database disconnected")

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
        
        # If connecting to a DIFFERENT url while already connected
        if self.conn:
            # We must disconnect first. But disconnect is async...
            # For simplicity in this sync connect helper, we just close directly if sqlite
            if not self.is_pg:
                self.conn.close()
            else:
                # It's harder for PG here, but we'll try
                try: self.conn.close()
                except: pass
            self.conn = None

        # Re-init lock for new connection/loop context
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
            self.conn.execute("PRAGMA foreign_keys=OFF")
        elif url.startswith("postgresql://") or url.startswith("postgres://"):
            try:
                import psycopg2
                from psycopg2.extras import DictCursor
            except ImportError:
                raise ImportError("PostgreSQL support requires 'psycopg2-binary'. Install it via pip.")
            
            self.is_pg = True
            logger.info(f"[DB] Connecting to PostgreSQL")
            self.conn = psycopg2.connect(url)
            self.conn.autocommit = True # Match SQLite isolation_level=None behavior
        else:
            raise ValueError(f"Unsupported database URL schema: {url}. Only sqlite:/// and postgresql:// are supported.")

        self.run_migrations()
        
    def run_migrations(self):
        c = self.conn
        # Ensure migrations table
        c.execute("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER)")
        
        # Load migration files from package using importlib.resources (pkg_resources is deprecated)
        files = []
        try:
            from importlib import resources
            # list files in openmemory.migrations (python 3.9+)
            files = [p.name for p in resources.files('openmemory.migrations').iterdir() if p.name.endswith(".sql")]
        except (ImportError, TypeError, AttributeError):
            # Fallback to direct file access for older python or package issues
            import os
            mig_path = Path(__file__).parent.parent / "migrations"
            if mig_path.exists():
                files = [f for f in os.listdir(mig_path) if f.endswith(".sql")]
            
        files.sort()
        
        for f in files:
            if not self.fetchone("SELECT 1 FROM _migrations WHERE name=?", (f,)):
                logger.info(f"[DB] Applying migration {f}")
                try:
                    # Read content
                    sql = None
                    try:
                        from importlib import resources
                        sql = resources.files('openmemory.migrations').joinpath(f).read_text(encoding='utf-8')
                    except:
                        pass
                    if not sql:
                        sql = (Path(__file__).parent.parent / "migrations" / f).read_text(encoding="utf-8")
                        
                    # Execute script
                    c.executescript(sql)
                    c.execute("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)", (f, int(time.time())))
                except Exception as e:
                    msg = str(e).lower()
                    if "duplicate column" in msg or "already exists" in msg:
                        logger.warning(f"[DB] Migration {f} skipped (duplicate/exists): {e}")
                        # Mark as applied so we don't retry forever if it's partially applied (though sqlite txn wraps it, some statements might be aggressive)
                        c.execute("INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)", (f, int(time.time())))
                    else:
                        logger.error(f"[DB] Migration {f} failed: {e}")
                        raise e
        
    def init_schema(self):
         # Legacy entry point, mapped to migrations now
         self.run_migrations()


    def execute(self, sql: str, params: tuple = ()) -> Any:
        self.connect()
        if self.is_pg:
            # Map ? to %s for psycopg2
            sql = sql.replace("?", "%s")
            cur = self.conn.cursor()
            cur.execute(sql, params)
            return cur
        return self.conn.execute(sql, params)
        
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
        if self.is_pg:
            # If not using DictCursor, wrap it
            from psycopg2.extras import RealDictRow
            return [dict(r) if isinstance(r, (dict, RealDictRow)) else r for r in rows]
        return [dict(r) for r in rows]
    
    def fetchone(self, sql: str, params: tuple = ()) -> Optional[Any]:
        self.connect()
        cur = self.execute(sql, params)
        row = cur.fetchone()
        if row and self.is_pg:
            from psycopg2.extras import RealDictRow
            return dict(row) if isinstance(row, (dict, RealDictRow)) else row
        return dict(row) if row else None
        
    async def async_execute(self, sql: str, params: tuple = ()) -> Any:
        async with self._lock:
            return await asyncio.to_thread(self.execute, sql, params)
        
    async def async_fetchone(self, sql: str, params: tuple = ()) -> Optional[Any]:
        async with self._lock:
            return await asyncio.to_thread(self.fetchone, sql, params)
        
    async def async_fetchall(self, sql: str, params: tuple = ()) -> List[Any]:
        async with self._lock:
            return await asyncio.to_thread(self.fetchall, sql, params)

    def commit(self):
        if self.conn and not self.is_pg: self.conn.commit()
        if self.conn and self.is_pg: self.conn.commit()

    async def async_commit(self):
        async with self._lock:
            await asyncio.to_thread(self.commit)

    def rollback(self):
        if self.conn: self.conn.rollback()
        
    async def async_rollback(self):
        async with self._lock:
            await asyncio.to_thread(self.rollback)

    from contextlib import asynccontextmanager
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
    async def ins_mem(self, **k):
        sql = """
        INSERT INTO memories(id, user_id, segment, content, simhash, primary_sector, tags, meta, created_at, updated_at, last_seen_at, salience, decay_lambda, version, mean_dim, mean_vec, compressed_vec, feedback_score)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
        user_id=excluded.user_id, segment=excluded.segment, content=excluded.content, simhash=excluded.simhash, primary_sector=excluded.primary_sector,
        tags=excluded.tags, meta=excluded.meta, created_at=excluded.created_at, updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at,
        salience=excluded.salience, decay_lambda=excluded.decay_lambda, version=excluded.version, mean_dim=excluded.mean_dim,
        mean_vec=excluded.mean_vec, compressed_vec=excluded.compressed_vec, feedback_score=excluded.feedback_score
        """
        vals = (
            k.get("id"), k.get("user_id"), k.get("segment", 0), k.get("content"), k.get("simhash"),
            k.get("primary_sector"), k.get("tags"), k.get("meta"), k.get("created_at"), k.get("updated_at"),
            k.get("last_seen_at"), k.get("salience", 1.0), k.get("decay_lambda", 0.02), k.get("version", 1),
            k.get("mean_dim"), k.get("mean_vec"), k.get("compressed_vec"), k.get("feedback_score", 0)
        )
        await db.async_execute(sql, vals)
        if k.get("commit", True): await db.async_commit()

    async def upd_mean_vec(self, mid: str, dim: int, vec: bytes, commit: bool = True):
        await db.async_execute("UPDATE memories SET mean_dim=?, mean_vec=? WHERE id=?", (dim, vec, mid))
        if commit: await db.async_commit()

    async def upd_compressed_vec(self, mid: str, vec: bytes, commit: bool = True):
        await db.async_execute("UPDATE memories SET compressed_vec=? WHERE id=?", (vec, mid))
        if commit: await db.async_commit()

    async def upd_feedback(self, mid: str, score: float, commit: bool = True):
        await db.async_execute("UPDATE memories SET feedback_score=? WHERE id=?", (score, mid))
        if commit: await db.async_commit()

    async def upd_seen(self, mid: str, last_seen: int, salience: float, updated: int, commit: bool = True):
        await db.async_execute("UPDATE memories SET last_seen_at=?, salience=?, updated_at=? WHERE id=?", (last_seen, salience, updated, mid))
        if commit: await db.async_commit()

    async def upd_mem(self, mid: str, content: str, tags: str, meta: str, updated: int, commit: bool = True):
        await db.async_execute("UPDATE memories SET content=?, tags=?, meta=?, updated_at=?, version=version+1 WHERE id=?", (content, tags, meta, updated, mid))
        if commit: await db.async_commit()

    async def upd_mem_with_sector(self, mid: str, content: str, sector: str, tags: str, meta: str, updated: int, user_id: str = None, commit: bool = True):
        user_clause = "AND user_id=?" if user_id else ""
        params = (content, sector, tags, meta, updated, mid) + ((user_id,) if user_id else ())
        await db.async_execute(f"UPDATE memories SET content=?, primary_sector=?, tags=?, meta=?, updated_at=?, version=version+1 WHERE id=? {user_clause}", params)
        if commit: await db.async_commit()

    async def get_mem(self, mid: str, user_id: str = None):
        user_clause = "AND user_id=?" if user_id else ""
        params = (mid,) + ((user_id,) if user_id else ())
        return await db.async_fetchone(f"SELECT * FROM memories WHERE id=? {user_clause}", params)

    async def get_mem_by_simhash(self, simhash: str, user_id: str = None):
        user_clause = "AND user_id=?" if user_id else "AND 1=1"
        params = (simhash,) + ((user_id,) if user_id else ())
        return await db.async_fetchone(f"SELECT * FROM memories WHERE simhash=? {user_clause} ORDER BY salience DESC LIMIT 1", params)
        
    async def all_mem(self, limit=10, offset=0, user_id: str = None):
        user_clause = "WHERE user_id=?" if user_id else ""
        params = ((user_id,) if user_id else ()) + (limit, offset)
        return await db.async_fetchall(f"SELECT * FROM memories {user_clause} ORDER BY created_at DESC LIMIT ? OFFSET ?", params)

    async def all_mem_by_sector(self, sector: str, limit=10, offset=0, user_id: str = None):
        user_clause = "AND user_id=?" if user_id else ""
        params = (sector,) + ((user_id,) if user_id else ()) + (limit, offset)
        return await db.async_fetchall(f"SELECT * FROM memories WHERE primary_sector=? {user_clause} ORDER BY created_at DESC LIMIT ? OFFSET ?", params)
        
    async def ins_log(self, id: str, model: str, status: str, ts: int, err: Optional[str] = None, commit: bool = True):
        await db.async_execute("INSERT INTO embed_logs(id, model, status, ts, err) VALUES (?,?,?,?,?)", (id, model, status, ts, err))
        if commit: await db.async_commit()
        
    async def upd_log(self, id: str, status: str, err: Optional[str] = None, commit: bool = True):
        await db.async_execute("UPDATE embed_logs SET status=?, err=? WHERE id=?", (status, err, id))
        if commit: await db.async_commit()
        
    async def all_mem_by_user(self, user_id: str, limit=10, offset=0):
        return await db.async_fetchall("SELECT * FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?", (user_id, limit, offset))
        
    async def get_active_users(self) -> List[Dict]:
        return await db.async_fetchall("SELECT DISTINCT user_id FROM memories WHERE user_id IS NOT NULL")
        
    async def get_segment_count(self, segment: int):
        return await db.async_fetchone("SELECT COUNT(*) as c FROM memories WHERE segment=?", (segment,))

    async def get_max_segment(self):
        return await db.async_fetchone("SELECT COALESCE(MAX(segment), 0) as max_seg FROM memories")

    async def get_segments(self):
        return await db.async_fetchall("SELECT DISTINCT segment FROM memories ORDER BY segment DESC")

    async def get_mem_by_segment(self, segment: int):
        return await db.async_fetchall("SELECT * FROM memories WHERE segment=? ORDER BY created_at DESC", (segment,))

    async def ins_waypoint(self, src: str, dst: str, uid: str, wt: float, created: int, updated: int, commit: bool = True):
        sql = """
        INSERT INTO waypoints (src_id, dst_id, user_id, weight, created_at, updated_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(src_id, dst_id, user_id) DO UPDATE SET weight=excluded.weight, updated_at=excluded.updated_at
        """
        await db.async_execute(sql, (src, dst, uid, wt, created, updated))
        if commit: await db.async_commit()

    async def get_neighbors(self, src_id: str, user_id: str = None):
        user_clause = "AND user_id=?" if user_id else ""
        params = (src_id,) + ((user_id,) if user_id else ())
        return await db.async_fetchall(f"SELECT dst_id, weight FROM waypoints WHERE src_id=? {user_clause} ORDER BY weight DESC", params)

    async def get_waypoints_by_src(self, src_id: str, user_id: str = None):
        user_clause = "AND user_id=?" if user_id else ""
        params = (src_id,) + ((user_id,) if user_id else ())
        return await db.async_fetchall(f"SELECT * FROM waypoints WHERE src_id=? {user_clause}", params)

    async def get_waypoint(self, src: str, dst: str, user_id: str = None):
        user_clause = "AND user_id=?" if user_id else ""
        params = (src, dst) + ((user_id,) if user_id else ())
        return await db.async_fetchone(f"SELECT weight FROM waypoints WHERE src_id=? AND dst_id=? {user_clause}", params)

    async def upd_waypoint(self, src: str, wt: float, updated: int, dst: str, user_id: str = None, commit: bool = True):
        user_clause = "AND user_id=?" if user_id else ""
        params = (wt, updated, src, dst) + ((user_id,) if user_id else ())
        await db.async_execute(f"UPDATE waypoints SET weight=?, updated_at=? WHERE src_id=? AND dst_id=? {user_clause}", params)
        if commit: await db.async_commit()

    async def del_waypoints(self, mid: str, commit: bool = True):
        await db.async_execute("DELETE FROM waypoints WHERE src_id=? OR dst_id=?", (mid, mid))
        if commit: await db.async_commit()

    async def prune_waypoints(self, threshold: float, user_id: str = None, commit: bool = True):
        user_clause = "AND user_id=?" if user_id else ""
        params = (threshold,) + ((user_id,) if user_id else ())
        await db.async_execute(f"DELETE FROM waypoints WHERE weight < ? {user_clause}", params)
        if commit: await db.async_commit()

    async def get_pending_logs(self):
        return await db.async_fetchall("SELECT * FROM embed_logs WHERE status=?", ("pending",))

    async def get_failed_logs(self):
        return await db.async_fetchall("SELECT * FROM embed_logs WHERE status=? ORDER BY ts DESC LIMIT 100", ("failed",))

    async def ins_user(self, uid: str, summary: str, reflection_count: int, created: int, updated: int, commit: bool = True):
        await db.async_execute("INSERT OR IGNORE INTO openmemory_users (user_id, summary, reflection_count, created_at, updated_at) VALUES (?,?,?,?,?)", (uid, summary, reflection_count, created, updated))
        if commit: await db.async_commit()

    async def get_user(self, uid: str):
        return await db.async_fetchone("SELECT * FROM openmemory_users WHERE user_id=?", (uid,))

    async def upd_user_summary(self, uid: str, summary: str, updated: int, commit: bool = True):
        await db.async_execute("UPDATE openmemory_users SET summary=?, reflection_count=reflection_count+1, updated_at=? WHERE user_id=?", (summary, updated, uid))
        if commit: await db.async_commit()

    async def get_classifier_model(self, user_id: str):
        return await db.async_fetchone("SELECT * FROM learned_models WHERE user_id=?", (user_id,))

    async def ins_classifier_model(self, user_id: str, weights: str, biases: str, version: int, updated_at: int, commit: bool = True):
        sql = "INSERT INTO learned_models(user_id, weights, biases, version, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET weights=excluded.weights, biases=excluded.biases, version=excluded.version, updated_at=excluded.updated_at"
        await db.async_execute(sql, (user_id, weights, biases, version, updated_at))
        if commit: await db.async_commit()

    async def get_training_data(self, user_id: str, limit: int = 1000):
        return await db.async_fetchall("SELECT primary_sector, mean_vec FROM memories WHERE user_id=? AND mean_vec IS NOT NULL LIMIT ?", (user_id, limit))

    async def clear_all(self, commit: bool = True):
        await db.async_execute("DELETE FROM memories")
        await db.async_execute("DELETE FROM vectors")
        await db.async_execute("DELETE FROM waypoints")
        await db.async_execute("DELETE FROM openmemory_users")
        await db.async_execute("DELETE FROM stats")
        await db.async_execute("DELETE FROM temporal_facts")
        await db.async_execute("DELETE FROM temporal_edges")
        if commit: await db.async_commit()

    async def del_mem(self, mid: str, user_id: str = None, commit: bool = True):
        """
        Delete a memory and its associated vectors/waypoints.
        
        Args:
            mid: Memory ID to delete.
            user_id: Optional user ownership check.
            commit: Whether to commit the transaction.
        """
        user_clause = "AND user_id=?" if user_id else ""
        params = (mid,) + ((user_id,) if user_id else ())
        await db.async_execute(f"DELETE FROM memories WHERE id=? {user_clause}", params)
        await db.async_execute("DELETE FROM vectors WHERE id=?", (mid,))
        await db.async_execute("DELETE FROM waypoints WHERE src_id=? OR dst_id=?", (mid, mid))
        if commit: await db.async_commit()


    async def del_mem_by_user(self, uid: str, commit: bool = True):
        await db.async_execute("DELETE FROM vectors WHERE id IN (SELECT id FROM memories WHERE user_id=?)", (uid,))
        await db.async_execute("DELETE FROM waypoints WHERE src_id IN (SELECT id FROM memories WHERE user_id=?) OR dst_id IN (SELECT id FROM memories WHERE user_id=?)", (uid, uid))
        await db.async_execute("DELETE FROM temporal_facts WHERE user_id=?", (uid,))
        await db.async_execute("DELETE FROM temporal_edges WHERE user_id=?", (uid,))
        await db.async_execute("DELETE FROM memories WHERE user_id=?", (uid,))
        if commit: await db.async_commit()

async def log_maint_op(m_type: str, count: int = 1):
    try:
        await db.async_execute("INSERT INTO stats (type, count, ts) VALUES (?, ?, ?)", (m_type, count, int(time.time() * 1000)))
        await db.async_commit()
    except Exception as e:
        logger.error(f"[DB] Maintenance log error: {e}")

q = Queries()

from contextlib import contextmanager

from contextlib import asynccontextmanager

@asynccontextmanager
async def transaction():
    await asyncio.to_thread(db.connect)
    # Serialize transactions to prevent "cannot start a transaction within a transaction"
    if db._tx_lock is None: db._tx_lock = asyncio.Lock()
    
    async with db._tx_lock:
        try:
            await db.async_execute("BEGIN")
            yield db.conn
            await db.async_commit()
        except Exception as e:
            await db.async_rollback()
            raise e
