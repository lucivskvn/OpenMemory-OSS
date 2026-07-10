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

    async def storeVector(self, id: str, sector: str, vector: List[float], dim: int, user_id: Optional[str] = None, project_id: Optional[str] = None):
        client = await self._get_client()
        uid = user_id or "anonymous"
        key = self._key(uid, sector, id)
        vec_bytes = np.array(vector, dtype=np.float32).tobytes()

        mapping = {
            "id": id,
            "sector": sector,
            "dim": dim,
            "v": vec_bytes,
            "user_id": uid,
            "project_id": project_id or "null"
        }
        await client.hset(key, mapping=mapping)

    def _dec(self, x):
        return x.decode('utf-8') if isinstance(x, bytes) else str(x)

    def _parse_item_to_row(self, item):
        if not item: return None
        v_bytes = item.get(b'v') or item.get('v')
        vec = list(np.frombuffer(v_bytes, dtype=np.float32))

        return VectorRow(
            self._dec(item.get(b'id') or item.get('id')),
            self._dec(item.get(b'sector') or item.get('sector')),
            vec,
            int(self._dec(item.get(b'dim') or item.get('dim'))),
            self._dec(item.get(b'user_id') or item.get('user_id'))
        )

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
                    row = self._parse_item_to_row(item)
                    if row:
                        results.append(row)
            if cursor == 0: break
        return results

    async def getVector(self, id: str, sector: str, user_id: Optional[str] = None) -> Optional[VectorRow]:
        client = await self._get_client()
        uid = user_id or "anonymous"
        key = self._key(uid, sector, id)
        item = await client.hgetall(key)
        return self._parse_item_to_row(item)

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

    def _should_filter(self, item, project_id):
        i_proj = self._dec(item.get(b'project_id') or item.get('project_id') or "null")
        if project_id:
            # system_global is exempt, "null" is private to unscoped queries
            if i_proj != project_id and i_proj != "system_global":
                return True
        return False

    def _calc_sim(self, v_bytes, query_vec, q_norm):
        v = np.frombuffer(v_bytes, dtype=np.float32)
        dot = np.dot(query_vec, v)
        norm = np.linalg.norm(v)
        return dot / (q_norm * norm) if (q_norm * norm) > 0 else 0

    def _parse_and_filter_results(self, items, query_vec, q_norm, project_id):
        batch_results = []
        for item in items:
            if not item or self._should_filter(item, project_id):
                continue
            v_bytes = item.get(b'v') or item.get('v')
            sim = self._calc_sim(v_bytes, query_vec, q_norm)
            batch_results.append({
                "id": self._dec(item.get(b'id') or item.get('id')),
                "similarity": float(sim)
            })
        return batch_results

    async def _scan_and_fetch(self, client, pattern, query_vec, q_norm, project_id):
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
            if cursor == 0: break
        return results

    async def search(self, vector: List[float], sector: str, k: int, filter: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        client = await self._get_client()
        query_vec = np.array(vector, dtype=np.float32)
        q_norm = np.linalg.norm(query_vec)
        project_id = filter.get("project_id") if filter else None
        user_id = filter.get("user_id") if filter else None
        pattern = f"{self.prefix}{user_id or '*'}:vector:{sector}:*"

        results = await self._scan_and_fetch(client, pattern, query_vec, q_norm, project_id)

        results.sort(key=lambda x: x["similarity"], reverse=True)
        return results[:k]
