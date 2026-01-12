from abc import ABC, abstractmethod
from typing import List, Optional, Dict, Any, Union
import json
import sqlite3
import struct
import os
from .db import db, DB, q
from .types import MemRow
import logging
from dataclasses import dataclass

# Ported from backend/src/core/vector_store.ts (implied) and db.ts logic

logger = logging.getLogger("vector_store")

@dataclass
class VectorRow:
    id: str
    sector: str
    vector: List[float]
    dim: int

class VectorStore(ABC):
    @abstractmethod
    async def storeVector(self, id: str, sector: str, vector: List[float], dim: int, user_id: Optional[str] = None): pass

    @abstractmethod
    async def storeVectors(self, rows: List[Dict[str, Any]]):
        """
        Batch store vectors. 
        Row format: {"id": str, "sector": str, "vector": List[float], "dim": int, "user_id": Optional[str]}
        """
        pass
    
    @abstractmethod
    async def getVectorsById(self, id: str, user_id: Optional[str] = None) -> List[VectorRow]: pass
    
    @abstractmethod
    async def getVectorsByMultipleIds(self, ids: List[str], user_id: Optional[str] = None) -> Dict[str, List[VectorRow]]: pass
    
    @abstractmethod
    async def getVector(self, id: str, sector: str, user_id: Optional[str] = None) -> Optional[VectorRow]: pass
    
    @abstractmethod

    @abstractmethod
    async def deleteVectors(self, id: str, sector: Optional[str] = None): pass

    @abstractmethod
    async def search(self, vector: List[float], sector: str, k: int, filters: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]: pass
    
    @abstractmethod
    async def disconnect(self): pass

class SQLiteVectorStore(VectorStore):
    def __init__(self, table_name: str = "vectors"):
        self.table = table_name
        
    async def storeVector(self, id: str, sector: str, vector: List[float], dim: int, user_id: Optional[str] = None):
        # sqlite blob
        blob = struct.pack(f"{len(vector)}f", *vector)
        sql = f"INSERT OR REPLACE INTO {self.table}(id, sector, user_id, v, dim) VALUES (?, ?, ?, ?, ?)"
        await db.async_execute(sql, (id, sector, user_id, blob, dim))

    async def storeVectors(self, rows: List[Dict[str, Any]]):
        if not rows: return
        data = []
        for r in rows:
            vec = r["vector"]
            blob = struct.pack(f"{len(vec)}f", *vec)
            data.append((r["id"], r["sector"], r.get("user_id"), blob, r["dim"]))
            
        sql = f"INSERT OR REPLACE INTO {self.table}(id, sector, user_id, v, dim) VALUES (?, ?, ?, ?, ?)"
        
        # Use executemany equivalent via db helper? db.async_execute is single.
        # We need a new batch execute helper in DB or loop here?
        # Looping here inside one lock acquisition is better than acquiring lock N times.
        # But we removed the lock! So we should implement executemany in DB.
        await db.async_executemany(sql, data)
        
    async def getVectorsById(self, id: str, user_id: Optional[str] = None) -> List[VectorRow]:
        sql = f"SELECT * FROM {self.table} WHERE id=?"
        params = [id]
        if user_id:
            sql += " AND user_id=?"
            params.append(user_id)
            
        rows = await db.async_fetchall(sql, tuple(params))
        res = []
        for r in rows:
            cnt = len(r["v"]) // 4
            vec = list(struct.unpack(f"{cnt}f", r["v"]))
            res.append(VectorRow(r["id"], r["sector"], vec, r["dim"]))
        return res

    async def getVectorsByMultipleIds(self, ids: List[str], user_id: Optional[str] = None) -> Dict[str, List[VectorRow]]:
        if not ids: return {}
        placeholders = ",".join(["?"] * len(ids))
        sql = f"SELECT * FROM {self.table} WHERE id IN ({placeholders})"
        params = list(ids)
        if user_id:
            sql += " AND user_id=?"
            params.append(user_id)
            
        rows = await db.async_fetchall(sql, tuple(params))
        res = {}
        for r in rows:
            mid = r["id"]
            if mid not in res: res[mid] = []
            cnt = len(r["v"]) // 4
            vec = list(struct.unpack(f"{cnt}f", r["v"]))
            res[mid].append(VectorRow(mid, r["sector"], vec, r["dim"]))
        return res

    async def getVector(self, id: str, sector: str, user_id: Optional[str] = None) -> Optional[VectorRow]:
        sql = f"SELECT * FROM {self.table} WHERE id=? AND sector=?"
        params = [id, sector]
        if user_id:
            sql += " AND user_id=?"
            params.append(user_id)
            
        r = await db.async_fetchone(sql, tuple(params))
        if not r: return None
        cnt = len(r["v"]) // 4
        vec = list(struct.unpack(f"{cnt}f", r["v"]))
        return VectorRow(r["id"], r["sector"], vec, r["dim"])
    
    async def deleteVectors(self, id: str, sector: Optional[str] = None):
        if sector:
            await db.async_execute(f"DELETE FROM {self.table} WHERE id=? AND sector=?", (id, sector))
        else:
            await db.async_execute(f"DELETE FROM {self.table} WHERE id=?", (id,))
        
    async def search(self, vector: List[float], sector: str, k: int, filters: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        # Optimized numpy implementation
        import numpy as np
        from .db import q # Import query helper for table names

        t = q.tables
        
        # 1. Fetch all vectors for sector (filtered by user if needed)
        filter_sql = ""
        params = [sector]
        
        # Determine if we need to JOIN for metadata filtering
        has_meta_filter = filters and filters.get("metadata")
        
        if has_meta_filter:
            # JOIN with memories table
            # Adjust query to select from vectors (alias v) joined with memories (alias m)
            base_sql = f"SELECT v.id, v.v FROM {self.table} v JOIN {t['memories']} m ON m.id = v.id WHERE v.sector=?"
        else:
             base_sql = f"SELECT id, v FROM {self.table} WHERE sector=?"

        if filters and filters.get("user_id"):
             # Ambiguous column name 'user_id' if joined, so qualify it if joining
             col = "v.user_id" if has_meta_filter else "user_id"
             filter_sql += f" AND {col}=?"
             params.append(filters["user_id"])

        if has_meta_filter:
            # Metadata filtering (Text-based LIKE for compatibility)
            meta = filters["metadata"]
            if isinstance(meta, dict):
                for key, val in meta.items():
                    if val is not None:
                        # Inspect JSON string for "key":"val" or similar. 
                        # Simple implementation mimicking JS: AND m.metadata LIKE %key%val%
                        filter_sql += " AND m.metadata LIKE ?"
                        params.append(f"%{key}%{val}%")

        sql = f"{base_sql} {filter_sql}"
        rows = await db.async_fetchall(sql, tuple(params))
        
        if not rows:
            return []

        # 2. Build Matrices
        # Query Matrix: (1, Dim)
        # Target Matrix: (N, Dim) -> but we stack them
        ids = []
        vectors = []
        
        for r in rows:
            ids.append(r["id"])
            cnt = len(r["v"]) // 4
            v = struct.unpack(f"{cnt}f", r["v"])
            vectors.append(v)
            
        if not vectors:
            return []
            
        target_matrix = np.array(vectors, dtype=np.float32) # (N, Dim)
        query_vec = np.array(vector, dtype=np.float32) # (Dim,)
        
        # 3. Norms
        q_norm = np.linalg.norm(query_vec)
        t_norms = np.linalg.norm(target_matrix, axis=1) # (N,)
        
        # 4. Dot Product
        # (N, Dim) dot (Dim,) -> (N,)
        dots = np.dot(target_matrix, query_vec)
        
        # 5. Cosine Similarity
        # Avoid division by zero
        denominators = q_norm * t_norms
        similarities = np.divide(dots, denominators, out=np.zeros_like(dots), where=denominators > 1e-9)
        
        # 6. Format Results
        results = []
        for i, score in enumerate(similarities):
            results.append({"id": ids[i], "score": float(score)})
            
        # 7. Sort and limit
        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:k]

    async def disconnect(self):
        # No-op for SQLite (shared connection managed by db module)
        pass


# Global store instance factory
from .config import env

def get_vector_store() -> VectorStore:
    # Use config env, with fallback to os.getenv if needed for legacy overrides not in config model
    # Note: openmemory-js uses "vectorBackend"
    backend = env.vector_store_backend or os.getenv("OPENMEMORY_VECTOR_STORE")
    
    # Auto-detect Postgres from DB URL if not explicitly set
    if not backend and env.database_url and (env.database_url.startswith("postgres://") or env.database_url.startswith("postgresql://")):
        backend = "postgres"
    
    backend = backend or "sqlite"
    
    if backend == "postgres":
        dsn = os.getenv("OPENMEMORY_PG_DSN") or env.db_url
        from .vector.postgres import PostgresVectorStore
        logger.info(f"Using PostgresVectorStore at {dsn}")
        return PostgresVectorStore(dsn, table_name=q.tables['vectors'])
        
    elif backend == "valkey" or backend == "redis":
        # Config has dynamic overrides? checks legacy env vars
        url = os.getenv("OPENMEMORY_REDIS_URL") or os.getenv("OM_REDIS_URL") or "redis://localhost:6379/0"
        from .vector.valkey import ValkeyVectorStore
        logger.info(f"Using ValkeyVectorStore at {url}")
        return ValkeyVectorStore(url)
        
    else:
        logger.info("Using SQLiteVectorStore")
        return SQLiteVectorStore()

vector_store = get_vector_store()
