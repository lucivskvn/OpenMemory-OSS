import httpx
import json
import asyncio
from typing import Optional, List, Dict, Any, Union
from .core.types import MemoryItem
from .main import Memory

class OpenMemoryError(Exception):
    """Base exception for OpenMemory API errors."""
    def __init__(self, message: str, status_code: Optional[int] = None, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.status_code = status_code
        self.details = details or {}

class MemoryClient:
    """
    OpenMemory HTTP Client.
    Provides a similar API to the embedded `Memory` class but communicates via REST.
    Includes automatic retry with exponential backoff for transient errors.
    """
    def __init__(
        self,
        base_url: str = "http://localhost:8080",
        token: Optional[str] = None,
        default_user: Optional[str] = None,
        max_retries: int = 3,
        retry_delay: float = 1.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.default_user = default_user
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self._client = httpx.AsyncClient(timeout=30.0)

    async def close(self):
        await self._client.aclose()

    async def health(self) -> bool:
        """Check server connectivity."""
        try:
            res = await self._request("GET", "/health")
            if isinstance(res, dict): return res.get("status") == "ok"
            return str(res).strip('"') == "ok"
        except:
            return False

    async def _request(self, method: str, path: str, json_body: Optional[Dict[str, Any]] = None, params: Optional[Dict[str, Any]] = None) -> Any:
        """
        Make an HTTP request with automatic retry for transient errors.
        """
        url = f"{self.base_url}{path}"
        headers = {
            "Content-Type": "application/json"
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
            headers["x-api-key"] = self.token

        last_error: Optional[Exception] = None

        for attempt in range(self.max_retries):
            try:
                resp = await self._client.request(method, url, json=json_body, params=params, headers=headers)

                if resp.status_code == 204:
                    return None

                # Check for retryable errors
                if resp.status_code == 429 or resp.status_code >= 500:
                    delay = self.retry_delay * (2 ** attempt)  # Exponential backoff
                    if attempt < self.max_retries - 1:
                        await asyncio.sleep(delay)
                        continue

                if resp.status_code >= 400:
                    try:
                        err = resp.json()
                        msg = err.get("detail") or err.get("message") or resp.text
                        details = err
                    except Exception:
                        msg = resp.text
                        details = {}
                    raise OpenMemoryError(f"OpenMemory API Error ({resp.status_code}): {msg}", status_code=resp.status_code, details=details)

                return resp.json()

            except httpx.RequestError as e:
                last_error = OpenMemoryError(f"Connection error: {e}")
                if attempt < self.max_retries - 1:
                    delay = self.retry_delay * (2 ** attempt)
                    await asyncio.sleep(delay)
                    continue
                raise last_error

        if last_error:
            raise last_error
        raise OpenMemoryError("Request failed after retries")

    async def add(self, content: str, user_id: Optional[str] = None, tags: Optional[List[str]] = None, metadata: Optional[Dict[str, Any]] = None, id: Optional[str] = None, created_at: Optional[int] = None) -> Dict[str, Any]:
        """Add a new memory item."""
        uid = user_id or self.default_user or "anonymous"
        body = {
            "content": content,
            "userId": uid,
            "tags": tags or [],
            "metadata": metadata or {},
            "id": id,
            "createdAt": created_at
        }
        body = {k: v for k, v in body.items() if v is not None}
        return await self._request("POST", "/memory/add", json_body=body)

    async def add_batch(self, items: List[Dict[str, Any]], user_id: Optional[str] = None) -> Dict[str, Any]:
        """Add multiple memory items in a single request."""
        uid = user_id or self.default_user or "anonymous"
        body = {
            "items": items,
            "userId": uid
        }
        return await self._request("POST", "/memory/batch", json_body=body)

    async def import_memory(self, content: str, user_id: Optional[str] = None, tags: Optional[List[str]] = None, metadata: Optional[Dict[str, Any]] = None, id: Optional[str] = None, created_at: Optional[int] = None) -> Dict[str, Any]:
        """
        Import a memory with explicit ID/timestamp (Alias for add with extras).
        """
        return await self.add(content=content, user_id=user_id, tags=tags, metadata=metadata, id=id, created_at=created_at)

    async def list_users(self) -> List[str]:
        """List all active users."""
        res = await self._request("GET", "/users")
        return res.get("users", []) if res else []

    async def search(self, query: str, user_id: Optional[str] = None, limit: int = 10, min_salience: Optional[float] = None) -> List[Dict[str, Any]]:
        """Search for memories."""
        uid = user_id or self.default_user or "anonymous"
        # Filter None from filters is tricky with nested. Re-construct.
        filters: Dict[str, Any] = {"userId": uid}  # type: ignore[assignment]
        if min_salience is not None:
            filters["minScore"] = min_salience  # type: ignore[index]

        body = {
            "query": query,
            "limit": limit,
            "filters": filters
        }

        res = await self._request("POST", "/memory/query", json_body=body)
        return res or []

    async def get(self, memory_id: str) -> Optional[Dict[str, Any]]:
        """Get a memory by ID."""
        try:
            return await self._request("GET", f"/memory/{memory_id}")
        except OpenMemoryError as e:
            if e.status_code == 404: return None
            raise e
        except Exception as e:
            # Fallback for other exceptions
            if "404" in str(e): return None
            raise e

    async def update(self, memory_id: str, content: Optional[str] = None, tags: Optional[List[str]] = None, metadata: Optional[Dict[str, Any]] = None) -> Any:
        """Update a memory."""
        body: Dict[str, Any] = {}
        if content is not None: body["content"] = content
        if tags is not None: body["tags"] = tags
        if metadata is not None: body["metadata"] = metadata

        return await self._request("PATCH", f"/memory/{memory_id}", json_body=body)

    async def delete(self, memory_id: str) -> bool:
        """Delete a memory."""
        await self._request("DELETE", f"/memory/{memory_id}")
        return True

    async def reinforce(self, memory_id: str, boost: float = 0.1, user_id: Optional[str] = None) -> Dict[str, Any]:
        """Reinforce a memory (increase salience)."""
        uid = user_id or self.default_user
        body = {"id": memory_id, "boost": boost, "userId": uid}
        body = {k: v for k, v in body.items() if v is not None}
        return await self._request("POST", "/memory/reinforce", json_body=body)

    async def list(self, limit: int = 100, offset: int = 0, user_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """List memories (history)."""
        uid = user_id or self.default_user or "anonymous"
        body = {
            "query": "",
            "userId": uid,
            "limit": limit
        }
        res = await self._request("POST", "/memory/query", json_body=body)
        return res or []

    async def ingest_url(self, url: str, user_id: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> Any:
        """Ingest content from a URL."""
        uid = user_id or self.default_user or "anonymous"
        body = {
            "source": "link", # JS uses 'link' or 'connector' usually, mapped to 'url' in client.ts request body 'data'
            "contentType": "html",
            "data": url,
            "userId": uid,
            "metadata": metadata or {}
        }
        return await self._request("POST", "/memory/ingest", json_body=body)

    async def add_fact(self, subject: str, predicate: str, target_object: str, valid_from: Optional[Union[str, int]] = None, confidence: float = 1.0, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Add a temporal fact."""
        body = {
            "subject": subject,
            "predicate": predicate,
            "object": target_object,
            "validFrom": valid_from,
            "confidence": confidence,
            "metadata": metadata
        }
        # Remove None values to avoid validation errors if optionals not None}
        body = {k: v for k, v in body.items() if v is not None}
        return await self._request("POST", "/api/temporal/fact", json_body=body)

    async def get_facts(self, subject: Optional[str] = None, predicate: Optional[str] = None, target_object: Optional[str] = None, at: Optional[Union[str, int]] = None, min_confidence: float = 0.1) -> List[Dict[str, Any]]:
        """Get temporal facts."""
        params = {
            "subject": subject,
            "predicate": predicate,
            "object": target_object,
            "at": at,
            "minConfidence": min_confidence
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
            "sourceId": source_id,
            "targetId": target_id,
            "relationType": relation_type,
            "validFrom": valid_from,
            "weight": weight,
            "metadata": metadata
        }
        body = {k: v for k, v in body.items() if v is not None}
        return await self._request("POST", "/api/temporal/edge", json_body=body)

    async def get_edges(self, source_id: Optional[str] = None, target_id: Optional[str] = None, relation_type: Optional[str] = None, at: Optional[Union[str, int]] = None) -> List[Dict[str, Any]]:
        """Get temporal edges."""
        params = {
            "sourceId": source_id,
            "targetId": target_id,
            "relationType": relation_type,
            "at": at
        }
        params = {k: v for k, v in params.items() if v is not None}
        res = await self._request("GET", "/api/temporal/edge", params=params)
        return res.get("edges", []) if res else []

    async def search_facts(self, pattern: str, search_type: str = "all", limit: int = 100) -> List[Dict[str, Any]]:
        """Search temporal facts by pattern."""
        params = {
            "pattern": pattern,
            "type": search_type,
            "limit": limit
        }
        res = await self._request("GET", "/api/temporal/search", params=params)
        return res.get("facts", []) if res else []

    async def get_current_fact(self, subject: str, predicate: str, at: Optional[Union[str, int]] = None) -> Optional[Dict[str, Any]]:
        """Get current valid fact."""
        params = {"subject": subject, "predicate": predicate}
        if at:
            params["at"] = at  # type: ignore[index]  # type: ignore[index]
        res = await self._request("GET", "/api/temporal/fact/current", params=params)
        return res.get("fact")

    async def update_fact(self, fact_id: str, confidence: Optional[float] = None, metadata: Optional[Dict[str, Any]] = None) -> None:
        """Update fact confidence or metadata."""
        body = {}
        if confidence is not None: body["confidence"] = confidence
        if metadata is not None: body["metadata"] = metadata
        await self._request("PATCH", f"/api/temporal/fact/{fact_id}", json_body=body)

    async def invalidate_fact(self, fact_id: str, valid_to: Optional[Union[str, int]] = None) -> None:
        """Invalidate (close) a temporal fact."""
        body = {"validTo": valid_to}
        await self._request("DELETE", f"/api/temporal/fact/{fact_id}", json_body=body)

    async def get_predicate_history(self, predicate: str, start: Optional[Union[str, int]] = None, end: Optional[Union[str, int]] = None) -> List[Dict[str, Any]]:
        """Get history of a predicate."""
        params = {"predicate": predicate}
        if start:
            params["from"] = start  # type: ignore[index]  # type: ignore[index]
        if end:
            params["to"] = end  # type: ignore[index]  # type: ignore[index]
        res = await self._request(
            "GET", "/api/temporal/history/predicate", params=params
        )
        return res.get("timeline", []) if res else []

    async def get_subject_facts(self, subject: str, at: Optional[Union[str, int]] = None, include_historical: bool = False) -> List[Dict[str, Any]]:
        """Get all facts for a subject."""
        params = {}
        if at:
            params["at"] = at  # type: ignore[index]  # type: ignore[index]
        if include_historical:
            params["includeHistorical"] = "true"
        res = await self._request("GET", f"/api/temporal/subject/{subject}", params=params)
        return res.get("facts", []) if res else []

    async def compare_facts(self, subject: str, time1: Union[str, int], time2: Union[str, int]) -> Dict[str, Any]:
        """Compare facts at two points in time."""
        params = {
            "subject": subject,
            "time1": time1,
            "time2": time2
        }
        return await self._request("GET", "/api/temporal/compare", params=params)

    async def get_temporal_stats(self) -> Dict[str, Any]:
        """Get temporal statistics."""
        return await self._request("GET", "/api/temporal/stats")

    async def apply_decay(self, decay_rate: float = 0.01) -> Dict[str, Any]:
        """Apply confidence decay globally."""
        return await self._request("POST", "/api/temporal/decay", json_body={"decayRate": decay_rate})

    async def get_volatile_facts(self, subject: Optional[str] = None, limit: int = 10) -> Dict[str, Any]:
        """Get most volatile facts."""
        params = {"limit": limit}
        if subject:
            params["subject"] = subject  # type: ignore[index]  # type: ignore[index]
        return await self._request("GET", "/api/temporal/volatile", params=params)

    async def invalidate_edge(self, edge_id: str, valid_to: Optional[Union[str, int]] = None) -> None:
        """Invalidate (close) a temporal edge."""
        body = {"validTo": valid_to}
        await self._request("DELETE", f"/api/temporal/edge/{edge_id}", json_body=body)

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

    # --- Users API ---

    async def get_user(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Get user profile."""
        try:
            return await self._request("GET", f"/users/{user_id}")
        except Exception as e:
            if "404" in str(e): return None
            raise e

    async def get_user_summary(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Get user summary."""
        try:
            return await self._request("GET", f"/users/{user_id}/summary")
        except:
            return None

    async def regenerate_user_summary(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Regenerate user summary."""
        return await self._request("POST", f"/users/{user_id}/summary/regenerate")

    async def get_user_memories(self, user_id: str, limit: int = 100, offset: int = 0) -> Dict[str, Any]:
        """Get memories for a specific user."""
        return await self._request("GET", f"/users/{user_id}/memories", params={"l": limit, "u": offset})

    async def delete_user_memories(self, user_id: str) -> Dict[str, Any]:
        """Delete all memories for a user."""
        return await self._request("DELETE", f"/users/{user_id}/memories")

    async def delete_all(self, user_id: str) -> Dict[str, Any]:
        """Delete all memories for a user (Alias)."""
        return await self.delete_user_memories(user_id)

    async def regenerate_all_user_summaries(self) -> Dict[str, Any]:
        """Regenerate summaries for all users (Admin)."""
        return await self._request("POST", "/users/summaries/regenerate-all")

    async def register_user(self, user_id: str, scope: str = "user") -> Dict[str, Any]:
        """Register a new user and generate API key (Admin)."""
        return await self._request("POST", "/users/register", json_body={"userId": user_id, "scope": scope})

    async def list_api_keys(self) -> List[Dict[str, Any]]:
        """List all active API keys (Admin)."""
        res = await self._request("GET", "/users/keys")
        return res.get("keys", []) if res else []

    async def revoke_api_key(self, prefix: str) -> Dict[str, Any]:
        """Revoke an API key by prefix (Admin)."""
        return await self._request("DELETE", f"/users/keys/{prefix}")

    # --- IDE API ---

    async def start_ide_session(self, project_name: str, ide_name: str, user_id: Optional[str] = None) -> Dict[str, Any]:
        """Start a new IDE session."""
        uid = user_id or self.default_user or "anonymous"
        body = {
            "projectName": project_name,
            "ideName": ide_name,
            "userId": uid
        }
        return await self._request("POST", "/api/ide/session/start", json_body=body)

    async def end_ide_session(self, session_id: str, user_id: Optional[str] = None) -> Dict[str, Any]:
        """End an IDE session."""
        uid = user_id or self.default_user or "anonymous"
        body = {
            "sessionId": session_id,
            "userId": uid
        }
        return await self._request("POST", "/api/ide/session/end", json_body=body)

    async def send_ide_event(self, session_id: str, event_type: str, file_path: str = "unknown", content: str = "", language: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None, user_id: Optional[str] = None) -> None:
        """Send an IDE event (save, open, etc)."""
        uid = user_id or self.default_user or "anonymous"
        body = {
            "sessionId": session_id,
            "eventType": event_type,
            "filePath": file_path,
            "content": content,
            "language": language,
            "metadata": metadata or {},
            "userId": uid
        }
        await self._request("POST", "/api/ide/events", json_body=body)

    async def get_ide_context(self, query: str, session_id: Optional[str] = None, file_path: Optional[str] = None, k: int = 5, user_id: Optional[str] = None) -> Dict[str, Any]:
        """Get IDE context."""
        uid = user_id or self.default_user
        body = {
            "query": query,
            "sessionId": session_id,
            "filePath": file_path,
            "k": k,
            "userId": uid
        }
        # Filter None
        body = {k: v for k, v in body.items() if v is not None}
        return await self._request("POST", "/api/ide/context", json_body=body)

    # --- Dynamics API ---

    async def get_dynamics_constants(self) -> Dict[str, Any]:
        """Get dynamics constants."""
        return await self._request("GET", "/dynamics/constants")

    async def calculate_salience(self, initial_salience: float = 0.5, decay_lambda: float = 0.01, recall_count: int = 0, emotional_frequency: float = 0, time_elapsed_days: float = 0) -> Dict[str, Any]:
        """Calculate modulated salience."""
        body = {
            "initialSalience": initial_salience,
            "decayLambda": decay_lambda,
            "recallCount": recall_count,
            "emotionalFrequency": emotional_frequency,
            "timeElapsedDays": time_elapsed_days
        }
        return await self._request("POST", "/dynamics/salience/calculate", json_body=body)

    async def calculate_resonance(self, memory_sector: str = "semantic", query_sector: str = "semantic", base_similarity: float = 0.8) -> Dict[str, Any]:
        """Calculate resonance."""
        body = {
            "memorySector": memory_sector,
            "querySector": query_sector,
            "baseSimilarity": base_similarity
        }
        return await self._request("POST", "/dynamics/resonance/calculate", json_body=body)

    async def retrieve_energy_based(self, query: str, sector: str = "semantic", min_energy: Optional[float] = None) -> Dict[str, Any]:
        """Energy-based retrieval."""
        body = {"query": query, "sector": sector}
        if min_energy is not None:
            body["minEnergy"] = min_energy  # type: ignore[index]
        return await self._request(
            "POST", "/dynamics/retrieval/energy-based", json_body=body
        )

    async def reinforce_trace(self, memory_id: str) -> Dict[str, Any]:
        """Reinforce trace."""
        return await self._request("POST", "/dynamics/reinforcement/trace", json_body={"memoryId": memory_id})

    async def spreading_activation(self, memory_ids: List[str], max_iterations: int = 3) -> Dict[str, Any]:
        """Spreading activation."""
        body = {"initialMemoryIds": memory_ids, "maxIterations": max_iterations}
        return await self._request("POST", "/dynamics/activation/spreading", json_body=body)

    async def get_waypoint_graph(self) -> Dict[str, Any]:
        """Get waypoint graph."""
        return await self._request("GET", "/dynamics/waypoints/graph")

    async def calculate_waypoint_weight(self, source_id: str, target_id: str) -> Dict[str, Any]:
        """Calculate waypoint weight."""
        body = {"sourceMemoryId": source_id, "targetMemoryId": target_id}
        return await self._request("POST", "/dynamics/waypoints/calculate-weight", json_body=body)

    # --- Sources API ---

    async def list_sources(self) -> Dict[str, Any]:
        """List available sources."""
        return await self._request("GET", "/sources")

    async def ingest_source(self, source: str, creds: Optional[Dict[str, Any]] = None, filters: Optional[Dict[str, Any]] = None, user_id: Optional[str] = None) -> Dict[str, Any]:
        """Ingest from source."""
        body = {
            "creds": creds or {},
            "filters": filters or {},
            "userId": user_id
        }
        return await self._request("POST", f"/sources/{source}/ingest", json_body=body)

    async def get_source_configs(self) -> List[Dict[str, Any]]:
        """Get source configurations."""
        res = await self._request("GET", "/source-configs")
        return res.get("configs", []) if res else []

    async def set_source_config(self, type: str, config: Dict[str, Any], status: str = "enabled") -> Dict[str, Any]:
        """Set source configuration."""
        body = {"config": config, "status": status}
        return await self._request("POST", f"/source-configs/{type}", json_body=body)

    async def delete_source_config(self, type: str) -> Dict[str, Any]:
        """Delete source configuration."""
        return await self._request("DELETE", f"/source-configs/{type}")

    # --- LangGraph API ---

    async def get_lg_config(self) -> Dict[str, Any]:
        """Get LangGraph config."""
        return await self._request("GET", "/lgm/config")

    async def lg_store(self, node: str, content: str, tags: Optional[List[str]] = None, metadata: Optional[Dict[str, Any]] = None, namespace: Optional[str] = None, graph_id: Optional[str] = None, reflective: Optional[bool] = None, user_id: Optional[str] = None) -> Dict[str, Any]:
        """Store LGM memory."""
        body = {
            "node": node,
            "content": content,
            "tags": tags,
            "metadata": metadata,
            "namespace": namespace,
            "graphId": graph_id,
            "reflective": reflective,
            "userId": user_id
        }
        # Filter None
        body = {k: v for k, v in body.items() if v is not None}
        return await self._request("POST", "/lgm/store", json_body=body)

    async def lg_retrieve(self, node: str, query: Optional[str] = None, namespace: Optional[str] = None, graph_id: Optional[str] = None, limit: int = 10,  user_id: Optional[str] = None) -> Dict[str, Any]:
        """Retrieve LGM memories."""
        body = {
            "node": node,
            "query": query,
            "namespace": namespace,
            "graphId": graph_id,
            "limit": limit,
            "userId": user_id
        }
        body = {k: v for k, v in body.items() if v is not None}
        return await self._request("POST", "/lgm/retrieve", json_body=body)

    async def lg_context(self, node: str, namespace: Optional[str] = None, graph_id: Optional[str] = None, user_id: Optional[str] = None) -> Dict[str, Any]:
        """Get LGM context."""
        body = {
            "node": node,
            "namespace": namespace,
            "graphId": graph_id,
            "userId": user_id
        }
        body = {k: v for k, v in body.items() if v is not None}
        return await self._request("POST", "/lgm/context", json_body=body)

    async def lg_reflect(self, node: str, graph_id: Optional[str] = None, content: Optional[str] = None, context_ids: Optional[List[str]] = None, namespace: Optional[str] = None, user_id: Optional[str] = None, depth: Optional[str] = None) -> Dict[str, Any]:
        """Trigger LGM reflection."""
        body = {
            "node": node,
            "graphId": graph_id,
            "content": content,
            "contextIds": context_ids,
            "namespace": namespace,
            "userId": user_id,
            "depth": depth
        }
        body = {k: v for k, v in body.items() if v is not None}
        body = {k: v for k, v in body.items() if v is not None}
        return await self._request("POST", "/lgm/reflection", json_body=body)

    # --- Compression API ---
    async def compress(self, text: str, algorithm: str = "semantic") -> Dict[str, Any]:
        """Compress text."""
        body = {"text": text, "algorithm": algorithm}
        return await self._request("POST", "/api/compression/test", json_body=body)

    async def get_compression_stats(self) -> Dict[str, Any]:
        """Get compression engine stats."""
        return await self._request("GET", "/api/compression/stats")

    # --- IDE Patterns ---
    async def get_ide_patterns(self, session_id: str) -> Dict[str, Any]:
        """Get detected patterns for a session."""
        return await self._request("GET", f"/api/ide/patterns/{session_id}")

    # --- Admin API ---
    async def export_data(self) -> str:
        """Export all data (Admin)."""
        url = f"{self.base_url}/admin/export"
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        resp = await self._client.get(url, headers=headers)
        if resp.status_code >= 400:
            raise OpenMemoryError(f"Export failed: {resp.text}", status_code=resp.status_code)
        return resp.text

    async def import_data(self, jsonl_data: str) -> Dict[str, Any]:
        """Import data (Admin)."""
        url = f"{self.base_url}/admin/import"
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        headers["Content-Type"] = "application/x-ndjson"
        resp = await self._client.post(url, content=jsonl_data, headers=headers)
        if resp.status_code >= 400:
            raise OpenMemoryError(f"Import failed: {resp.text}", status_code=resp.status_code)
        return resp.json()

Client = Memory # Default to direct DB client for backward compat
OpenMemory = Memory

__all__ = ["Memory", "MemoryClient", "Client", "OpenMemory"]
