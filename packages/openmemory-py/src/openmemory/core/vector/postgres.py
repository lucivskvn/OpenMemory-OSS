from typing import List, Optional, Dict, Any
import json
import logging
from ..types import MemRow
from ..vector_store import VectorStore, VectorRow

logger = logging.getLogger("vector_store.postgres")

class PostgresVectorStore(VectorStore):
    def __init__(self, dsn: str, table_name: str = "openmemory_vectors"):
        self.dsn = dsn
        self.table = table_name
        self.pool = None

    async def _get_pool(self):
        import asyncpg
        if not self.pool:
            self.pool = await asyncpg.create_pool(self.dsn)
            async with self.pool.acquire() as conn:
                await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
                logger.info("pgvector extension enabled")
                
                await conn.execute(f"""
                    CREATE TABLE IF NOT EXISTS {self.table} (
                        id TEXT NOT NULL,
                        sector TEXT NOT NULL,
                        user_id TEXT NOT NULL,
                        project_id TEXT,
                        v vector,
                        dim INTEGER,
                        created_at TIMESTAMPTZ DEFAULT NOW(),
                        PRIMARY KEY (id, sector, user_id)
                    )
                """)
                
                await conn.execute(f"CREATE INDEX IF NOT EXISTS {self.table}_user_idx ON {self.table} (user_id)")

                await conn.execute(f"""
                    CREATE INDEX IF NOT EXISTS {self.table}_hnsw_idx
                    ON {self.table} USING hnsw (v vector_cosine_ops)
                """)
                logger.info(f"HNSW index created on {self.table} for fast ANN queries")
        return self.pool

    async def storeVector(self, id: str, sector: str, vector: List[float], dim: int, user_id: Optional[str] = None, project_id: Optional[str] = None):
        pool = await self._get_pool()
        vec_str = str(vector)
        uid = user_id or "anonymous"

        sql = f"""
            INSERT INTO {self.table} (id, sector, user_id, project_id, v, dim)
            VALUES ($1, $2, $3, $4, $5::vector, $6)
            ON CONFLICT (id, sector, user_id) DO UPDATE SET
                project_id = EXCLUDED.project_id,
                v = EXCLUDED.v,
                dim = EXCLUDED.dim
        """
        async with pool.acquire() as conn:
            await conn.execute(sql, id, sector, uid, project_id, vec_str, dim)

    async def getVectorsById(self, id: str, user_id: Optional[str] = None, project_id: Optional[str] = None) -> List[VectorRow]:
        pool = await self._get_pool()
        sql = f"SELECT id, sector, user_id, project_id, v::text as v_txt, dim FROM {self.table} WHERE id=$1"
        params = [id]
        param_idx = 2
        if user_id:
            sql += f" AND user_id=${param_idx}"
            params.append(user_id)
            param_idx += 1
        if project_id:
            sql += f" AND project_id=${param_idx}"
            params.append(project_id)

        async with pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)

        res = []
        for r in rows:
            vec = json.loads(r["v_txt"])
            res.append(VectorRow(r["id"], r["sector"], vec, r["dim"], r["user_id"], r["project_id"]))
        return res

    async def getVector(self, id: str, sector: str, user_id: Optional[str] = None, project_id: Optional[str] = None) -> Optional[VectorRow]:
        pool = await self._get_pool()
        sql = f"SELECT id, sector, user_id, project_id, v::text as v_txt, dim FROM {self.table} WHERE id=$1 AND sector=$2"
        params = [id, sector]
        param_idx = 3
        if user_id:
            sql += f" AND user_id=${param_idx}"
            params.append(user_id)
            param_idx += 1
        if project_id:
            sql += f" AND project_id=${param_idx}"
            params.append(project_id)

        async with pool.acquire() as conn:
            r = await conn.fetchrow(sql, *params)

        if not r: return None
        vec = json.loads(r["v_txt"])
        return VectorRow(r["id"], r["sector"], vec, r["dim"], r["user_id"], r["project_id"])

    async def deleteVectors(self, id: str, user_id: Optional[str] = None, project_id: Optional[str] = None):
        pool = await self._get_pool()
        sql = f"DELETE FROM {self.table} WHERE id=$1"
        params = [id]
        param_idx = 2
        if user_id:
            sql += f" AND user_id=${param_idx}"
            params.append(user_id)
            param_idx += 1
        if project_id:
            sql += f" AND project_id=${param_idx}"
            params.append(project_id)

        async with pool.acquire() as conn:
            await conn.execute(sql, *params)

    async def search(self, vector: List[float], sector: str, k: int, filter: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        pool = await self._get_pool()
        vec_str = str(vector)

        filter_sql = " AND sector=$2"
        args = [vec_str, sector]
        arg_idx = 3

        if filter and filter.get("user_id"):
            filter_sql += f" AND user_id=${arg_idx}"
            args.append(filter["user_id"])
            arg_idx += 1

        if filter and filter.get("project_id"):
            filter_sql += f" AND project_id=${arg_idx}"
            args.append(filter["project_id"])
            arg_idx += 1

        sql = f"""
            SELECT id, 1 - (v <=> $1::vector) as similarity
            FROM {self.table}
            WHERE 1=1 {filter_sql}
            ORDER BY v <=> $1::vector
            LIMIT {k}
        """

        async with pool.acquire() as conn:
            rows = await conn.fetch(sql, *args)

        return [{"id": r["id"], "similarity": float(r["similarity"])} for r in rows]
