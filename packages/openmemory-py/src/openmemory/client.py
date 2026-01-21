"""
Audited: 2026-01-19
"""
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
        retries: int = 3,
        timeout: float = 10.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.default_user = default_user
        self.retries = retries
        self._client = httpx.AsyncClient(timeout=timeout)

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

        import asyncio
        delay = 1.0
        last_exception = None

        for attempt in range(self.retries + 1):
            try:
                resp = await self._client.request(
                    method, url, json=json_body, params=params, headers=headers
                )

                if resp.status_code == 204:
                    return None
                    
                # Retry on Server Errors (5xx) or Rate Limits (429)
                if resp.status_code >= 500 or resp.status_code == 429:
                    if attempt < self.retries:
                        await asyncio.sleep(delay)
                        delay *= 2  # Exponential backoff
                        continue
                    # Else fall through to error handling

                if resp.status_code >= 400:
                    try:
                        err = resp.json()
                        msg = err.get("detail") or err.get("message") or resp.text
                    except:
                        msg = resp.text
                    raise Exception(f"OpenMemory API Error ({resp.status_code}): {msg}")

                return resp.json()
            except httpx.RequestError as e:
                last_exception = e
                if attempt < self.retries:
                    await asyncio.sleep(delay)
                    delay *= 2
                    continue
        
        raise Exception(f"Connection error after {self.retries} retries: {last_exception}")

    async def add(
        self,
        content: str,
        user_id: Optional[str] = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Add a new memory item."""
        uid = user_id or self.default_user or "anonymous"
        body = {
            "content": content,
            "userId": uid,
            "tags": tags or [],
            "metadata": metadata or {},
        }
        return await self._request("POST", "/memory/add", json_body=body)

    async def add_batch(
        self,
        items: List[Dict[str, Any]],
        user_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Add multiple memories in batch."""
        uid = user_id or self.default_user or "anonymous"
        formatted_items = []
        for item in items:
            formatted_items.append({
                "content": item["content"],
                "tags": item.get("tags", []),
                "metadata": item.get("metadata", {}),
            })

        res = await self._request("POST", "/memory/batch", json_body={
            "items": formatted_items,
            "userId": uid
        })
        return res.get("items", []) if res else []

    async def import_memory(
        self,
        content: str,
        memory_id: Optional[str] = None,
        created_at: Optional[int] = None,
        user_id: Optional[str] = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Import a memory with specific ID and timestamp."""
        uid = user_id or self.default_user or "anonymous"
        body = {
            "content": content,
            "userId": uid,
            "tags": tags or [],
            "metadata": metadata or {},
        }
        if memory_id:
            body["id"] = memory_id
        if created_at:
            body["createdAt"] = created_at

        return await self._request("POST", "/memory/add", json_body=body)

    async def search(
        self,
        query: str,
        user_id: Optional[str] = None,
        limit: int = 10,
        min_salience: Optional[float] = None,
    ) -> List[Dict[str, Any]]:
        """Search for memories."""
        uid = user_id or self.default_user
        body = {
            "query": query,
            "userId": uid,
            "k": limit,
            "filters": {"minScore": 0, "minSalience": min_salience},
        }
        if min_salience is None:
            del body["filters"]["minSalience"]

        res = await self._request("POST", "/memory/query", json_body=body)
        return res.get("matches", []) if res else []

    async def get(self, memory_id: str) -> Optional[Dict[str, Any]]:
        """Get a memory by ID."""
        try:
            return await self._request("GET", f"/memory/{memory_id}")
        except Exception as e:
            if "404" in str(e) or "404" in str(type(e)):
                return None
            raise

    async def update(self, memory_id: str, content: Optional[str] = None, tags: Optional[List[str]] = None, metadata: Optional[Dict[str, Any]] = None) -> Any:
        """Update a memory."""
        body: Dict[str, Any] = {"id": memory_id}
        if content is not None:
            body["content"] = content
        if tags is not None: body["tags"] = tags
        if metadata is not None: body["metadata"] = metadata

        return await self._request("PATCH", f"/memory/{memory_id}", json_body=body)

    async def update_batch(self, items: List[Dict[str, Any]], user_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Update multiple memories in batch."""
        res = await self._request("PATCH", "/memory/batch", json_body={
            "items": items,
            "userId": user_id or self.default_user
        })
        return res.get("items", []) if res else []

    async def delete(self, memory_id: str) -> bool:
        """Delete a memory."""
        await self._request("DELETE", f"/memory/{memory_id}")
        return True

    async def delete_batch(self, memory_ids: List[str]) -> bool:
        """Delete multiple memories (Bulk operation)."""
        await self._request("DELETE", "/memory/batch", json_body={"ids": memory_ids})
        return True

    async def delete_many(self, memory_ids: List[str]) -> bool:
        """Deprecated: Use delete_batch instead."""
        return await self.delete_batch(memory_ids)

    async def delete_user_memories(self, user_id: Optional[str] = None) -> Dict[str, Any]:
        """Delete all memories for a user."""
        uid = user_id or self.default_user
        params = {}
        if uid:
            params["userId"] = uid
        
        res = await self._request("DELETE", "/memory/all", params=params)
        return {
            "success": res.get("ok", res.get("success", True)),
            "deletedCount": res.get("deleted", res.get("deletedCount", 0))
        }

    async def delete_all(self, user_id: Optional[str] = None) -> Dict[str, Any]:
        """Delete all memories for a user (Alias for delete_user_memories)."""
        return await self.delete_user_memories(user_id)

    async def reinforce(self, memory_id: str, boost: float = 0.1) -> bool:
        """Reinforce a memory (increase salience)."""
        await self._request(
            "POST", f"/memory/{memory_id}/reinforce", json_body={"boost": boost}
        )
        return True

    async def list(self, limit: int = 100, offset: int = 0, user_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """List memories (paginated)."""
        uid = user_id or self.default_user
        params = {"l": limit, "u": offset}
        if uid:
            params["userId"] = uid
        res = await self._request("GET", "/memory/all", params=params)
        return res.get("items", []) if res else []

    async def ingest_url(self, url: str, user_id: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None, config: Optional[Dict[str, Any]] = None) -> Any:
        """Ingest content from a URL."""
        uid = user_id or self.default_user or "anonymous"
        body = {
            "url": url,
            "metadata": metadata or {},
            "config": config or {},
            "userId": uid
        }
        return await self._request("POST", "/memory/ingest/url", json_body=body)

    async def ingest(
        self,
        content: Union[str, bytes],
        content_type: str,
        user_id: Optional[str] = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Ingest a document (text or binary).
        For binary types (pdf, docx, audio, video), content should be bytes (will be base64 encoded) or base64 string.
        For text types, content should be string or utf-8 bytes.
        """
        uid = user_id or self.default_user or "anonymous"
        
        data_payload = content
        
        # Heuristic to determine if we should base64 encode bytes or decode them as text
        # This matches server-side assumption in src/ops/extract.ts
        is_binary_type = any(t in content_type.lower() for t in [
            'pdf', 'docx', 'doc', 'audio', 'video', 'image', 'application/octet-stream'
        ])

        if isinstance(content, bytes):
            if is_binary_type:
                import base64
                data_payload = base64.b64encode(content).decode('utf-8')
            else:
                # Assume text (md, txt, html, json, etc)
                data_payload = content.decode('utf-8', errors='ignore')

        body = {
            "data": data_payload,
            "contentType": content_type,
            "userId": uid,
            "tags": tags or [],
            "metadata": metadata or {},
            "config": config or {},
        }
        return await self._request("POST", "/memory/ingest", json_body=body)

    async def list_users(self) -> List[str]:
        """List all active user IDs (Admin)."""
        res = await self._request("GET", "/admin/users")
        return res.get("users", []) if res else []

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
            "validFrom": str(valid_from) if valid_from else None,
            "confidence": confidence,
            "metadata": metadata,
        }
        # Remove None values
        body = {k: v for k, v in body.items() if v is not None}
        return await self._request("POST", "/temporal/fact", json_body=body)

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
            "minConfidence": min_confidence, # Server QueryFactSchema uses minConfidence
        }
        # Remove None
        params = {k: v for k, v in params.items() if v is not None}
        res = await self._request("GET", "/temporal/fact", params=params)
        return res.get("facts", []) if res else []

    async def get_timeline(self, subject: str, predicate: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get entity timeline."""
        params = {"subject": subject}
        if predicate:
            params["predicate"] = predicate
        res = await self._request("GET", "/temporal/timeline", params=params)
        return res.get("timeline", []) if res else []

    async def add_edge(self, source_id: str, target_id: str, relation_type: str, valid_from: Optional[Union[str, int]] = None, weight: float = 1.0, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Add a temporal edge."""
        body = {
            "sourceId": source_id, # Server CreateEdgeSchema uses sourceId (camelCase)
            "targetId": target_id, # Server uses targetId
            "relationType": relation_type, # Server uses relationType
            "validFrom": valid_from, # Server uses validFrom
            "weight": weight,
            "metadata": metadata,
        }
        body = {k: v for k, v in body.items() if v is not None}
        return await self._request("POST", "/temporal/edge", json_body=body)

    async def get_edges(self, source_id: Optional[str] = None, target_id: Optional[str] = None, relation_type: Optional[str] = None, at: Optional[Union[str, int]] = None) -> List[Dict[str, Any]]:
        """Get temporal edges."""
        params = {
            "sourceId": source_id, # Server EdgeQuerySchema uses sourceId
            "targetId": target_id, # Server uses targetId
            "relationType": relation_type, # Server uses relationType
            "at": at,
        }
        params = {k: v for k, v in params.items() if v is not None}
        res = await self._request("GET", "/temporal/edge", params=params)
        return res.get("edges", []) if res else []

    async def search_facts(
        self, pattern: str, field: str = "subject", limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Search temporal facts by pattern."""
        params = {"pattern": pattern, "field": field, "limit": limit}
        res = await self._request("GET", "/temporal/search", params=params)
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

    async def register_user(self, user_id: str, summary: Optional[str] = None) -> Dict[str, Any]:
        """Register a new user (Admin)."""
        return await self._request("POST", "/admin/users", json_body={"userId": user_id, "summary": summary})

    async def list_api_keys(self, user_id: str) -> List[Dict[str, Any]]:
        """List API keys for a user."""
        res = await self._request("GET", f"/admin/users/{user_id}/keys")
        return res.get("keys", []) if res else []

    async def start_ide_session(self, project_name: str, ide_name: str, user_id: Optional[str] = None) -> Dict[str, Any]:
        """Start an IDE session."""
        uid = user_id or self.default_user or "anonymous"
        return await self._request("POST", "/ide/session/start", json_body={
            "projectName": project_name,
            "ideName": ide_name,
            "userId": uid
        })

    async def send_ide_event(self, session_id: str, event_type: str, file_path: str, content: str, language: str, metadata: Optional[Dict[str, Any]] = None, user_id: Optional[str] = None):
        """Send an IDE event."""
        uid = user_id or self.default_user or "anonymous"
        await self._request("POST", "/ide/events", json_body={
            "sessionId": session_id,
            "eventType": event_type,
            "filePath": file_path,
            "content": content,
            "language": language,
            "metadata": metadata or {},
            "userId": uid
        })

    async def get_current_fact(self, subject: str, predicate: str, at: Optional[Union[str, int]] = None) -> Optional[Dict[str, Any]]:
        """Get the current valid fact."""
        params = {"subject": subject, "predicate": predicate}
        if at: params["at"] = str(at)
        res = await self._request("GET", "/temporal/fact/current", params=params)
        return res.get("fact") if res else None

    async def spreading_activation(self, initial_memory_ids: List[str], max_iterations: int = 3) -> Dict[str, Any]:
        """Run spreading activation."""
        return await self._request("POST", "/dynamics/activation/spreading", json_body={
            "initialMemoryIds": initial_memory_ids,
            "maxIterations": max_iterations
        })

    async def calculate_salience(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Calculate salience."""
        return await self._request("POST", "/dynamics/salience/calculate", json_body=params)


# Ergonomic Aliases
Client = Memory  # Default to direct DB client for backward compat
OpenMemory = Memory

__all__ = ["Memory", "MemoryClient", "Client", "OpenMemory"]
