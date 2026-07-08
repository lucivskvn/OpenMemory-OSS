from typing import List, Optional, Dict, Any
import json
import logging
import asyncio
import numpy as np
from ..vector_store import VectorStore, VectorRow

logger = logging.getLogger("vector_store.valkey")

class ValkeyVectorStore(VectorStore):
    def __init__(self, url: str, prefix: str = "om:"):
        self.url = url
        self.prefix = prefix
        self.client = None

    async def _get_client(self):
        import redis.asyncio as redis
        if not self.client:
            self.client = redis.from_url(self.url)
        return self.client

    def _key(self, user_id: str, sector: str, id: str) -> str:
        return f"{self.prefix}{user_id}:vector:{sector}:{id}"

    async def storeVector(self, id: str, sector: str, vector: List[float], dim: int, user_id: Optional[str] = None):
        client = await self._get_client()
        uid = user_id or "anonymous"
        key = self._key(uid, sector, id)
        vec_bytes = np.array(vector, dtype=np.float32).tobytes()

        mapping = {
            "id": id,
            "sector": sector,
            "dim": dim,
            "v": vec_bytes,
            "user_id": uid
        }
        await client.hset(key, mapping=mapping)

    async def getVectorsById(self, id: str, user_id: Optional[str] = None) -> List[VectorRow]:
        client = await self._get_client()
        uid = user_id or "*"
        pattern = f"{self.prefix}{uid}:vector:*:{id}"

        cursor = 0
        results = []
        while True:
            cursor, keys = await client.scan(cursor, match=pattern, count=100)
            if keys:
                pipe = client.pipeline()
                for key in keys:
                    pipe.hgetall(key)
                items = await pipe.execute()

                for item in items:
                    if not item: continue
                    def dec(x): return x.decode('utf-8') if isinstance(x, bytes) else str(x)

                    v_bytes = item.get(b'v') or item.get('v')
                    vec = list(np.frombuffer(v_bytes, dtype=np.float32))

                    results.append(VectorRow(
                        dec(item.get(b'id') or item.get('id')),
                        dec(item.get(b'sector') or item.get('sector')),
                        vec,
                        int(dec(item.get(b'dim') or item.get('dim'))),
                        dec(item.get(b'user_id') or item.get('user_id'))
                    ))
            if cursor == 0: break
        return results

    async def getVector(self, id: str, sector: str, user_id: Optional[str] = None) -> Optional[VectorRow]:
        client = await self._get_client()
        uid = user_id or "anonymous"
        key = self._key(uid, sector, id)
        item = await client.hgetall(key)
        if not item: return None

        def dec(x): return x.decode('utf-8') if isinstance(x, bytes) else str(x)
        v_bytes = item.get(b'v') or item.get('v')
        vec = list(np.frombuffer(v_bytes, dtype=np.float32))

        return VectorRow(
            dec(item.get(b'id') or item.get('id')),
            dec(item.get(b'sector') or item.get('sector')),
            vec,
            int(dec(item.get(b'dim') or item.get('dim'))),
            dec(item.get(b'user_id') or item.get('user_id'))
        )

    async def deleteVectors(self, id: str, user_id: Optional[str] = None):
        client = await self._get_client()
        uid = user_id or "*"
        pattern = f"{self.prefix}{uid}:vector:*:{id}"
        cursor = 0
        while True:
            cursor, keys = await client.scan(cursor, match=pattern, count=100)
            if keys:
                await client.delete(*keys)
            if cursor == 0: break

    def _parse_and_filter_results(self, items, query_vec, q_norm, project_id):
        batch_results = []
        for item in items:
            if not item: continue
            def dec(x): return x.decode('utf-8') if isinstance(x, bytes) else str(x)

            if project_id:
                i_proj = dec(item.get(b'project_id') or item.get('project_id'))
                if i_proj != project_id and i_proj != "system_global" and i_proj != "null":
                    continue

            v_bytes = item.get(b'v') or item.get('v')
            v = np.frombuffer(v_bytes, dtype=np.float32)

            dot = np.dot(query_vec, v)
            norm = np.linalg.norm(v)
            sim = dot / (q_norm * norm) if (q_norm * norm) > 0 else 0

            batch_results.append({
                "id": dec(item.get(b'id') or item.get('id')),
                "similarity": float(sim)
            })
        return batch_results

    async def search(self, vector: List[float], sector: str, k: int, filter: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        client = await self._get_client()
        query_vec = np.array(vector, dtype=np.float32)
        q_norm = np.linalg.norm(query_vec)

        user_id = filter.get("user_id") if filter else None
        project_id = filter.get("project_id") if filter else None

        pattern = f"{self.prefix}{user_id or '*'}:vector:{sector}:*"
        fetch_k = k * 5 if project_id else k

        cursor = 0
        results = []

        while True:
            cursor, keys = await client.scan(cursor, match=pattern, count=100)
            if keys:
                pipe = client.pipeline()
                for key in keys:
                    pipe.hgetall(key)
                items = await pipe.execute()
                results.extend(self._parse_and_filter_results(items, query_vec, q_norm, project_id))
                if len(results) >= fetch_k: break

            if cursor == 0 or len(results) >= fetch_k: break

        results.sort(key=lambda x: x["similarity"], reverse=True)
        return results[:k]
