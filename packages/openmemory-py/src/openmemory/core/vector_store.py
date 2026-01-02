from abc import ABC, abstractmethod
from typing import List, Optional, Dict, Any, Union
import json
import sqlite3
import struct
from .db import db, DB
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
    async def getVectorsById(self, id: str, user_id: Optional[str] = None) -> List[VectorRow]: pass
    
    @abstractmethod
    async def getVector(self, id: str, sector: str, user_id: Optional[str] = None) -> Optional[VectorRow]: pass
    
    @abstractmethod
    async def deleteVectors(self, id: str): pass
    
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
    
    async def deleteVectors(self, id: str):
        await db.async_execute(f"DELETE FROM {self.table} WHERE id=?", (id,))
        
    async def search(self, vector: List[float], sector: str, k: int, filter: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        # Optimized numpy implementation
        import numpy as np

        # 1. Fetch all vectors for sector (filtered by user if needed)
        filter_sql = ""
        params = [sector]
        if filter and filter.get("user_id"):
            filter_sql += " AND user_id=?"
            params.append(filter["user_id"])
            
        sql = f"SELECT id, v FROM {self.table} WHERE sector=? {filter_sql}"
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
import os

def get_vector_store() -> VectorStore:
    backend = os.getenv("OPENMEMORY_VECTOR_STORE", "sqlite")
    
    if backend == "postgres":
        dsn = os.getenv("OPENMEMORY_PG_DSN", "postgresql://user:pass@localhost:5432/db")
        from .vector.postgres import PostgresVectorStore
        logger.info(f"Using PostgresVectorStore at {dsn}")
        return PostgresVectorStore(dsn)
        
    elif backend == "valkey" or backend == "redis":
        url = os.getenv("OPENMEMORY_REDIS_URL", "redis://localhost:6379/0")
        from .vector.valkey import ValkeyVectorStore
        logger.info(f"Using ValkeyVectorStore at {url}")
        return ValkeyVectorStore(url)
        
    else:
        logger.info("Using SQLiteVectorStore")
        return SQLiteVectorStore()

vector_store = get_vector_store()
