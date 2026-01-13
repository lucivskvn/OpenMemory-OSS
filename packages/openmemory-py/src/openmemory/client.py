import httpx
import json
from typing import Optional, List, Dict, Any, Union
from .core.types import MemoryItem
from .main import Memory


class MemoryClient:
    """
    OpenMemory HTTP Client.
    Provides a similar API to the embedded `Memory` class but communicates via REST.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8000",
        token: Optional[str] = None,
        default_user: Optional[str] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.default_user = default_user
        self._client = httpx.AsyncClient(timeout=30.0)

    async def close(self):
        await self._client.aclose()

    async def health(self) -> bool:
        """Check server connectivity."""
        try:
            res = await self._request("GET", "/health")
            # Usually /health returns {"status": "ok"} or string "ok"
            # Adjust based on server implementation. Assuming JSON default.
            if isinstance(res, dict):
                return res.get("status") == "ok"
            return str(res).strip('"') == "ok"
        except:
            return False

    async def _request(
        self,
        method: str,
        path: str,
        json_body: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        headers = {
            "Content-Type": "application/json"
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
            headers["x-api-key"] = self.token

        try:
            resp = await self._client.request(
                method, url, json=json_body, params=params, headers=headers
            )

            if resp.status_code == 204:
                return None

            if resp.status_code >= 400:
                try:
                    err = resp.json()
                    msg = err.get("detail") or err.get("message") or resp.text
                except:
                    msg = resp.text
                raise Exception(f"OpenMemory API Error ({resp.status_code}): {msg}")

            return resp.json()
        except httpx.RequestError as e:
            raise Exception(f"Connection error: {e}")

    async def add(
        self,
        content: str,
        user_id: Optional[str] = None,
        tags: Optional[List[str]] = None,
        meta: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Add a new memory item."""
        uid = user_id or self.default_user or "anonymous"
        body = {
            "content": content,
            "user_id": uid,
            "tags": tags or [],
            "meta": meta or {},
        }
        return await self._request("POST", "/memory/add", json_body=body)

    async def search(
        self,
        query: str,
        user_id: Optional[str] = None,
        limit: int = 10,
        min_salience: Optional[float] = None,
    ) -> List[Dict[str, Any]]:
        """Search for memories."""
        uid = user_id or self.default_user or "anonymous"
        body = {
            "query": query,
            "user_id": uid,
            "limit": limit,
            "filters": {"min_score": 0, "minSalience": min_salience},  # Default
        }
        # Filter None from filters
        if min_salience is None:
            del body["filters"]["minSalience"]

        res = await self._request("POST", "/memory/query", json_body=body)
        return res or []

    async def get(self, memory_id: str) -> Optional[Dict[str, Any]]:
        """Get a memory by ID."""
        try:
            return await self._request("GET", f"/memory/{memory_id}")
        except Exception as e:
            if "404" in str(e):
                return None
            raise e

    async def update(self, memory_id: str, content: Optional[str] = None, tags: Optional[List[str]] = None, metadata: Optional[Dict[str, Any]] = None) -> Any:
        """Update a memory."""
        body: Dict[str, Any] = {"id": memory_id}
        if content is not None:
            body["content"] = content
        if tags is not None: body["tags"] = tags
        if metadata is not None: body["metadata"] = metadata

        return await self._request("PUT", f"/memory/{memory_id}", json_body=body)

    async def delete(self, memory_id: str) -> bool:
        """Delete a memory."""
        await self._request("DELETE", f"/memory/{memory_id}")
        return True

    async def reinforce(self, memory_id: str, boost: float = 0.1) -> bool:
        """Reinforce a memory (increase salience)."""
        await self._request(
            "POST", f"/memory/{memory_id}/reinforce", json_body={"boost": boost}
        )
        return True

    async def list(self, limit: int = 100, offset: int = 0, user_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """List memories (history)."""
        uid = user_id or self.default_user or "anonymous"
        # Using query endpoint as history/list proxy
        body = {
            "query": "",  # Empty query for all/history
            "user_id": uid,
            "limit": limit,
        }
        res = await self._request("POST", "/memory/query", json_body=body)
        return res or []

    async def ingest_url(self, url: str, user_id: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> Any:
        """Ingest content from a URL."""
        uid = user_id or self.default_user or "anonymous"
        body = {
            "source": "link",  # JS uses 'link' or 'connector' usually, mapped to 'url' in client.ts request body 'data'
            "content_type": "html",
            "data": url,
            "user_id": uid,
            "metadata": metadata or {},
        }
        return await self._request("POST", "/memory/ingest", json_body=body)

    async def add_fact(
        self,
        subject: str,
        predicate: str,
        object: str,
        valid_from: Optional[Union[str, int]] = None,
        confidence: float = 1.0,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Add a temporal fact."""
        body = {
            "subject": subject,
            "predicate": predicate,
            "object": object,
            "valid_from": valid_from,
            "confidence": confidence,
            "metadata": metadata,
        }
        # Remove None values to avoid validation errors if optional
        body = {k: v for k, v in body.items() if v is not None}
        return await self._request("POST", "/api/temporal/fact", json_body=body)

    async def get_facts(
        self,
        subject: Optional[str] = None,
        predicate: Optional[str] = None,
        object: Optional[str] = None,
        at: Optional[Union[str, int]] = None,
        min_confidence: float = 0.1,
    ) -> List[Dict[str, Any]]:
        """Get temporal facts."""
        params = {
            "subject": subject,
            "predicate": predicate,
            "object": object,
            "at": at,
            "min_confidence": min_confidence,
        }
        # Remove None
        params = {k: v for k, v in params.items() if v is not None}
        res = await self._request("GET", "/api/temporal/fact", params=params)
        return res.get("facts", []) if res else []

    async def get_timeline(self, subject: str, predicate: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get entity timeline."""
        params = {"subject": subject}
        if predicate:
            params["predicate"] = predicate
        res = await self._request("GET", "/api/temporal/timeline", params=params)
        return res.get("timeline", []) if res else []

    async def add_edge(self, source_id: str, target_id: str, relation_type: str, valid_from: Optional[Union[str, int]] = None, weight: float = 1.0, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Add a temporal edge."""
        body = {
            "source_id": source_id,
            "target_id": target_id,
            "relation_type": relation_type,
            "valid_from": valid_from,
            "weight": weight,
            "metadata": metadata,
        }
        body = {k: v for k, v in body.items() if v is not None}
        return await self._request("POST", "/api/temporal/edge", json_body=body)

    async def get_edges(self, source_id: Optional[str] = None, target_id: Optional[str] = None, relation_type: Optional[str] = None, at: Optional[Union[str, int]] = None) -> List[Dict[str, Any]]:
        """Get temporal edges."""
        params = {
            "source_id": source_id,
            "target_id": target_id,
            "relation_type": relation_type,
            "at": at,
        }
        params = {k: v for k, v in params.items() if v is not None}
        res = await self._request("GET", "/api/temporal/edge", params=params)
        return res.get("edges", []) if res else []

    async def search_facts(
        self, pattern: str, field: str = "subject", limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Search temporal facts by pattern."""
        params = {"pattern": pattern, "field": field, "limit": limit}
        res = await self._request("GET", "/api/temporal/search", params=params)
        return res.get("facts", []) if res else []

    # --- Dashboard / Admin API ---

    async def get_stats(self) -> Optional[Dict[str, Any]]:
        """Get system statistics."""
        try:
            return await self._request("GET", "/dashboard/stats")
        except:
            return None

    async def get_activity(self, limit: int = 50) -> List[Dict[str, Any]]:
        """Get recent activity."""
        res = await self._request("GET", f"/dashboard/activity?limit={limit}")
        return res.get("activities", []) if res else []

    async def get_top_memories(self, limit: int = 10) -> List[Dict[str, Any]]:
        """Get top active memories."""
        res = await self._request("GET", f"/dashboard/top-memories?limit={limit}")
        return res.get("memories", []) if res else []

    async def get_sector_timeline(self, hours: int = 24) -> Dict[str, Any]:
        """Get memory distribution timeline by sector."""
        res = await self._request("GET", f"/dashboard/sectors/timeline?hours={hours}")
        return res or {"timeline": [], "grouping": "hour"}

    async def get_maintenance_stats(self, hours: int = 24) -> Optional[Dict[str, Any]]:
        """Get maintenance operation stats."""
        try:
            return await self._request("GET", f"/dashboard/maintenance?hours={hours}")
        except:
            return None


# Ergonomic Aliases
Client = Memory  # Default to direct DB client for backward compat
OpenMemory = Memory

__all__ = ["Memory", "MemoryClient", "Client", "OpenMemory"]
