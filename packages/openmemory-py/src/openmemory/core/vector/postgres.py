from typing import List, Optional, Dict, Any
import asyncio
import json
import logging
from ..types import MemRow
from ..vector_store import VectorStore, VectorRow

# You should install asyncpg: pip install asyncpg
# And ensure pgvector extension is enabled in your DB: CREATE EXTENSION vector;

logger = logging.getLogger("vector_store.postgres")

class PostgresVectorStore(VectorStore):
    def __init__(self, dsn: str, table_name: str = "vectors"):
        self.dsn = dsn
        self.table = table_name
        self.pool = None
        self._pool_lock = asyncio.Lock()

    async def _get_pool(self):
        import asyncpg  # type: ignore[import]

        async with self._pool_lock:
            if not self.pool:
                self.pool = await asyncpg.create_pool(self.dsn)
            # Ensure table exists with correct composite primary key
            async with self.pool.acquire() as conn:
                await conn.execute(f"""
                    CREATE TABLE IF NOT EXISTS {self.table} (
                        id TEXT NOT NULL,
                        sector TEXT NOT NULL,
                        user_id TEXT,
                        v vector,
                        dim INTEGER,
                        created_at TIMESTAMPTZ DEFAULT NOW(),
                        PRIMARY KEY (id, sector)
                    )
                """)
                # Index for similarity search
                try:
                    await conn.execute(f"CREATE INDEX IF NOT EXISTS {self.table}_idx ON {self.table} USING hnsw (v vector_cosine_ops)")
                    await conn.execute(f"CREATE INDEX IF NOT EXISTS {self.table}_sector_idx ON {self.table} (sector)")
                    await conn.execute(f"CREATE INDEX IF NOT EXISTS {self.table}_uid_idx ON {self.table} (user_id)")
                except Exception as e:
                    logger.warning(f"Vector index creation warning: {e}")

    async def storeVector(self, id: str, sector: str, vector: List[float], dim: int, user_id: Optional[str] = None):
        pool = await self._get_pool()
        # pgvector expects a list of floats, asyncpg handles it if registered or passed as array string?
        # Actually asyncpg needs manual casting or use of pgvector-python type if registered.
        # Simplest way: pass as string list format '[1.1,2.2,...]'
        vec_str = json.dumps(vector) # use json.dumps for standard formatting

        sql = f"""
            INSERT INTO {self.table} (id, sector, user_id, v, dim)
            VALUES ($1, $2, $3, $4::vector, $5)
            ON CONFLICT (id, sector) DO UPDATE SET
                user_id = EXCLUDED.user_id,
                v = EXCLUDED.v,
                dim = EXCLUDED.dim
        """
        async with pool.acquire() as conn:  # type: ignore[union-attr]  # type: ignore[union-attr]
            await conn.execute(sql, id, sector, user_id, vec_str, dim)

    async def storeVectors(self, rows: List[Dict[str, Any]]):
        if not rows: return
        # Batch insert for PG using executemany semantics of asyncpg
        pool = await self._get_pool()

        # asyncpg.executemany is efficient
        sql = f"""
            INSERT INTO {self.table} (id, sector, user_id, v, dim)
            VALUES ($1, $2, $3, $4::vector, $5)
            ON CONFLICT (id, sector) DO UPDATE SET
                user_id = EXCLUDED.user_id,
                v = EXCLUDED.v,
                dim = EXCLUDED.dim
        """

        # Prepare data tuples
        data = []
        for r in rows:
            vec_str = json.dumps(r["vector"])
            data.append((r["id"], r["sector"], r.get("user_id"), vec_str, r["dim"]))

        async with pool.acquire() as conn:  # type: ignore[union-attr]  # type: ignore[union-attr]
            await conn.executemany(sql, data)

    async def getVectorsById(self, id: str, user_id: Optional[str] = None) -> List[VectorRow]:
        pool = await self._get_pool()
        sql = f"SELECT id, sector, v::text as v_txt, dim FROM {self.table} WHERE id=$1"
        args = [id]
        if user_id:
            sql += " AND user_id=$2"
            args.append(user_id)

        async with pool.acquire() as conn:  # type: ignore[union-attr]  # type: ignore[union-attr]
            rows = await conn.fetch(sql, *args)

        res = []
        for r in rows:
            # Parse "[1.0, 2.0]" string back to list
            vec = json.loads(r["v_txt"])
            res.append(VectorRow(r["id"], r["sector"], vec, r["dim"]))
        return res

    async def getVectorsByMultipleIds(self, ids: List[str], user_id: Optional[str] = None) -> Dict[str, List[VectorRow]]:
        if not ids: return {}
        pool = await self._get_pool()
        placeholders = ",".join([f"${i+1}" for i in range(len(ids))])
        sql = f"SELECT id, sector, v::text as v_txt, dim FROM {self.table} WHERE id IN ({placeholders})"
        args = list(ids)
        if user_id:
            sql += f" AND user_id=${len(ids)+1}"
            args.append(user_id)

        async with pool.acquire() as conn:  # type: ignore[union-attr]  # type: ignore[union-attr]
            rows = await conn.fetch(sql, *args)

        res = {}
        for r in rows:
            mid = r["id"]
            if mid not in res: res[mid] = []
            vec = json.loads(r["v_txt"])
            res[mid].append(VectorRow(mid, r["sector"], vec, r["dim"]))
        return res

    async def getVector(self, id: str, sector: str, user_id: Optional[str] = None) -> Optional[VectorRow]:
        pool = await self._get_pool()
        sql = f"SELECT id, sector, v::text as v_txt, dim FROM {self.table} WHERE id=$1 AND sector=$2"
        args = [id, sector]
        if user_id:
            sql += " AND user_id=$3"
            args.append(user_id)

        async with pool.acquire() as conn:  # type: ignore[union-attr]  # type: ignore[union-attr]
            r = await conn.fetchrow(sql, *args)

        if not r: return None
        vec = json.loads(r["v_txt"])
        return VectorRow(r["id"], r["sector"], vec, r["dim"])

    async def deleteVectors(self, id: str, sector: Optional[str] = None):
        pool = await self._get_pool()
        async with pool.acquire() as conn:  # type: ignore[union-attr]  # type: ignore[union-attr]
            if sector:
                await conn.execute(f"DELETE FROM {self.table} WHERE id=$1 AND sector=$2", id, sector)
            else:
                await conn.execute(f"DELETE FROM {self.table} WHERE id=$1", id)

    async def search(self, vector: List[float], sector: str, k: int, filters: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        pool = await self._get_pool()
        vec_str = json.dumps(vector)

        from ..db import q
        t = q.tables

        # Determine if we need to JOIN for metadata filtering
        has_meta = filters and filters.get("metadata")

        if has_meta:
            table_clause = f"{self.table} v JOIN {t['memories']} m ON m.id = v.id"
        else:
            table_clause = f"{self.table} v"

        filter_sql = " AND v.sector=$2"
        args = [vec_str, sector]
        arg_idx = 3

        if filters and filters.get("user_id"):
            filter_sql += f" AND v.user_id=${arg_idx}"
            args.append(filters["user_id"])
            arg_idx += 1

        if has_meta:
            meta = filters["metadata"]  # type: ignore[index]  # type: ignore[index]
            if isinstance(meta, dict):
                for key, val in meta.items():
                    if val is not None:
                        # Simple text search on metadata for parity
                        filter_sql += f" AND m.metadata LIKE ${arg_idx}"
                        args.append(f"%{key}%{val}%")
                        arg_idx += 1

        # <=> is cosine distance operator
        sql = f"""
            SELECT v.id, 1 - (v.v <=> $1::vector) as similarity
            FROM {table_clause}
            WHERE 1=1 {filter_sql}
            ORDER BY v.v <=> $1::vector
            LIMIT {k}
        """

        async with pool.acquire() as conn:  # type: ignore[union-attr]  # type: ignore[union-attr]
            rows = await conn.fetch(sql, *args)

        return [{"id": r["id"], "score": float(r["similarity"])} for r in rows]

    async def disconnect(self):
        if self.pool:
            await self.pool.close()
            self.pool = None
