import logging
from typing import List, Dict, Optional, Any
import json
import asyncio
import sys
import time

from .core.db import db, q
from .memory.hsg import hsg_query, add_hsg_memory, add_hsg_memories
from .core.security import get_encryption
from .ops.ingest import ingest_document
from .openai_handler import OpenAIRegistrar
from .core.types import MemoryItem
from .core.config import env
from .utils.logger import setup_logging

__version__ = "2.3.0"

setup_logging()
logger = logging.getLogger("openmemory")

class Memory:
    """
    Main client for the OpenMemory ecosystem.

    Provides high-level access to memory ingestion, semantic search, retrieval, recall,
    and cognitive sector management. This client handles connection management,
    security (AES-256-GCM), and integration with vector stores.

    If `mode='remote'` is passed, returns a `MemoryClient` instance instead.

    Attributes:
        default_user (Optional[str]): The default user ID to use for operations if not specified.
    """

    def __new__(cls, user: Optional[str] = None, mode: str = "local", **kwargs):
        if mode == "remote":
            # Avoid circular import
            from .client import MemoryClient
            base_url = kwargs.get("url") or kwargs.get("base_url") or "http://localhost:8000"
            token = kwargs.get("api_key") or kwargs.get("token")
            return MemoryClient(base_url=base_url, token=token, default_user=user)
        return super(Memory, cls).__new__(cls)

    def __init__(self, user: Optional[str] = None, **kwargs):
        """
        Initialize the Memory client.

        Args:
            user (Optional[str]): Default user ID for all operations. Defaults to None.
            **kwargs: Configuration overrides passed to `env.update_config`. Common options:
                db_url (str): Database connection string (sqlite:// or postgres://).
                openai_key (str): OpenAI API Key.
                tier (str): Performance tier ('fast', 'smart', 'deep', 'hybrid').
        """
        self.default_user = user

        # Apply runtime configuration overrides
        if kwargs:
            env.update_config(**kwargs)
            db.connect(force=True)
        else:
            # Initialize DB normally
            db.connect()

        self._openai = OpenAIRegistrar(self)

    @property
    def openai(self):
        """Access the OpenAI handler registry."""
        return self._openai

    async def add(
        self, content: str, user_id: Optional[str] = None, **kwargs
    ) -> MemoryItem:
        """
        Ingest a new memory into the system.

        The content is processed, classified into cognitive sectors, embedded,
        and stored with AES-256-GCM encryption.

        Args:
            content (str): The raw text content to memorize.
            user_id (Optional[str]): The owner of the memory. Defaults to `self.default_user`.
            **kwargs: Additional options:
                tags (List[str]): List of tags for organization.
                meta (Dict[str, Any]): Arbitrary metadata dictionary.

        Returns:
            MemoryItem: The fully processed and stored memory object.

        Raises:
            ValueError: If memory creation fails or no ID is returned.
            RuntimeError: If consistency check fails immediately after creation.
        """
        uid = user_id or self.default_user
        meta_val = kwargs.get("metadata") or kwargs.get("meta") or {}
        tags_val = kwargs.get("tags") or []
        res = await ingest_document(
            "text", content, meta=meta_val, user_id=uid, tags=tags_val
        )

        mid = res.get("root_memory_id") or res.get("id")
        if not mid:
            raise ValueError("Failed to create memory: no ID returned")

        # Retry get() a few times to handle potential race/consistency lag (e.g. WAL)
        for _ in range(3):
            item = await self.get(mid, user_id=uid)
            if item: return item
            await asyncio.sleep(0.05)

        raise RuntimeError(f"Memory {mid} created but not found")

    async def add_batch(
        self,
        items: List[Dict[str, Any]],
        user_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        High-throughput batch ingestion of multiple memories.
        
        Args:
            items: List of dictionaries with 'content' (required), 'tags' (optional), 'metadata' (optional).
            user_id: The owner of the memories.
            
        Returns:
            List of result dictionaries containing 'id' and 'sectors'.
        """
        uid = user_id or self.default_user
        return await add_hsg_memories(items, user_id=uid)

    async def import_memory(
        self, content: str, user_id: Optional[str] = None, **kwargs
    ) -> MemoryItem:
        """
        Import a memory (Admin/Restore) with explicit ID/timestamp control.
        Bypasses standard ingestion chunking to preserve original structure.
        """
        uid = user_id or self.default_user
        meta_val = kwargs.get("meta") or {}
        tags_val = kwargs.get("tags") or []
        id_override = kwargs.get("id")
        created_at = kwargs.get("created_at")

        # Direct call to add_hsg_memory (bypassing ingest/chunking)
        res = await add_hsg_memory(
            content, 
            tags=json.dumps(tags_val), 
            metadata=meta_val, 
            user_id=uid, 
            commit=True, 
            id_override=id_override, 
            created_at_override=int(created_at) if created_at else None
        )

        mid = res.get("id")
        if not mid:
            raise ValueError("Failed to import memory: no ID returned")
            
        return await self.get(mid, user_id=uid)

    async def search(
        self, query: str, user_id: Optional[str] = None, limit: int = 10, **kwargs
    ) -> List[MemoryItem]:
        """
        Perform a hybrid semantic and keyword search.

        Retrieves memories relevant to the query based on vector similarity and algorithmic
        salience scoring.

        Args:
            query (str): The natural language search query.
            user_id (Optional[str]): Restrict search to this user's memories. Defaults to `self.default_user`.
            limit (int): Maximum number of results to return. Defaults to 10.
            **kwargs: Filter options:
                sector (str): Restrict to a specific sector (e.g., 'episodic').
                tags (List[str]): Filter by tags.
                min_score (float): Minimum similarity threshold.

        Returns:
            List[MemoryItem]: Ranked list of matching memories, sorted by relevance.
        """
        uid = user_id or self.default_user
        filters = kwargs.copy()
        filters["user_id"] = uid
        return await hsg_query(query, limit, filters)

    async def get(
        self, memory_id: str, user_id: Optional[str] = None
    ) -> Optional[MemoryItem]:
        """
        Retrieve a specific memory by its unique ID.

        Handles decryption of content and parsing of metadata.

        Args:
            memory_id (str): The unique identifier of the memory.
            user_id (Optional[str]): ownership check. If provided, strict ownership is enforced.
                                   Defaults to `self.default_user`.

        Returns:
            Optional[MemoryItem]: The memory object if found and authorized, otherwise None.
        """
        uid = user_id or self.default_user
        m = await q.get_mem(memory_id)

        # Ownership check
        if m and uid and m.get("user_id") and m.get("user_id") != uid:
            return None

        if m:
            m = dict(m)
            try:
                enc = get_encryption()
                m["content"] = enc.decrypt(m["content"])
                return MemoryItem(
                    id=m["id"],
                    content=m["content"],
                    primary_sector=m["primary_sector"],
                    sectors=[m["primary_sector"]],
                    created_at=m["created_at"],
                    updated_at=m["updated_at"],
                    last_seen_at=m["last_seen_at"],
                    tags=json.loads(m["tags"] or "[]"),
                    metadata=json.loads(m.get("metadata") or m.get("meta") or "{}"),
                    salience=m["salience"],
                    decay_lambda=m["decay_lambda"],
                    version=m["version"],
                    segment=m["segment"],
                    simhash=m["simhash"],
                    generated_summary=m["generated_summary"],
                    user_id=m["user_id"],
                    feedback_score=m.get("feedback_score") or 0.0,
                    _debug=None,
                )
            except Exception as e:
                logger.error(f"failed to decrypt/parse memory {memory_id}: {e}")
        return None

    async def update(
        self,
        memory_id: str,
        content: Optional[str] = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        user_id: Optional[str] = None,
    ) -> MemoryItem:
        """
        Update an existing memory.

        Args:
            memory_id (str): The ID of the memory to update.
            content (Optional[str]): New text content. Replaces existing content.
            tags (Optional[List[str]]): New list of tags. Replaces existing tags.
            metadata (Optional[Dict[str, Any]]): New metadata dictionary. Merges or replaces.
            user_id (Optional[str]): Ownership check. Defaults to `self.default_user`.

        Returns:
            MemoryItem: The updated memory object.

        Raises:
            ValueError: If the memory does not exist.
            PermissionError: If the user is not authorized to modify this memory.
        """
        uid = user_id or self.default_user
        # Check ownership
        m = await q.get_mem(memory_id)
        if not m:
            raise ValueError(f"Memory {memory_id} not found")
        if uid and m.get("user_id") and m.get("user_id") != uid:
            raise PermissionError("Access denied")

        # Update memory fields
        import time

        ts = int(time.time())
        if content:
            await q.upd_mem_with_sector(
                memory_id,
                content,
                m.get("primary_sector", "general"),
                json.dumps(tags) if tags else m.get("tags", "[]"),
                json.dumps(metadata) if metadata else (m.get("metadata") or m.get("meta") or "{}"),
                ts,
                uid,
            )

        item = await self.get(memory_id, user_id=uid)
        if not item:
            raise ValueError(f"Memory {memory_id} not found after update")
        return item

    async def reinforce(
        self, memory_id: str, boost: float = 0.1, user_id: Optional[str] = None
    ):
        """
        Boost the salience of a memory manually.

        Reinforcement prevents decay and increases the likelihood of retrieval.

        Args:
            memory_id (str): The ID of the memory to reinforce.
            boost (float): The magnitude of the boost (0.0 to 1.0). Defaults to 0.1.
            user_id (Optional[str]): Ownership check. Defaults to `self.default_user`.

        Raises:
            ValueError: If the memory does not exist.
            PermissionError: If access is denied.
        """
        uid = user_id or self.default_user
        m = await q.get_mem(memory_id)
        if not m:
            raise ValueError(f"Memory {memory_id} not found")
        if uid and m.get("user_id") and m.get("user_id") != uid:
            raise PermissionError("Access denied")

        from .memory.hsg import reinforce_memory as _reinforce
        await _reinforce(memory_id, boost)

    async def delete(self, memory_id: str, user_id: Optional[str] = None):
        """
        Permanently delete a memory and its associated vectors.

        Args:
            memory_id (str): The ID of the memory to delete.
            user_id (Optional[str]): Ownership check. Defaults to `self.default_user`.

        Raises:
            PermissionError: If access is denied.
        """
        uid = user_id or self.default_user
        # Check ownership before delete
        m = await q.get_mem(memory_id)
        if m and uid and m.get("user_id") and m.get("user_id") != uid:
            raise PermissionError("Access denied")
        await q.del_mem(memory_id, user_id=uid)

    async def delete_all(self, user_id: Optional[str] = None):
        """
        Delete ALL memories for a specific user.

        Args:
            user_id (Optional[str]): The user ID to purge. Defaults to `self.default_user`.
        """
        uid = user_id or self.default_user
        if uid:
            await q.del_mem_by_user(uid)

    async def history(
        self, user_id: Optional[str] = None, limit: int = 20, offset: int = 0
    ) -> List[MemoryItem]:
        """
        Retrieve chronological memory history.

        Args:
            user_id (Optional[str]): The user to retrieve history for. Defaults to `self.default_user`.
            limit (int): Number of items to retrieve. Defaults to 20.
            offset (int): Pagination offset. Defaults to 0.

        Returns:
            List[MemoryItem]: List of memories, typically ordered by creation date desc.

        Raises:
            ValueError: If user_id is not provided or set in default.
        """
        uid = user_id or self.default_user
        if not uid:
            raise ValueError("user_id is required")
        rows = await q.all_mem_by_user(uid, limit, offset)
        enc = get_encryption()

        res = []
        for r in rows:
            try:
                m = dict(r)
                m["content"] = enc.decrypt(m["content"])
                item = MemoryItem(
                    id=m["id"],
                    content=m["content"],
                    primary_sector=m["primary_sector"],
                    sectors=[m["primary_sector"]],
                    created_at=m["created_at"],
                    updated_at=m["updated_at"],
                    last_seen_at=m["last_seen_at"],
                    tags=json.loads(m["tags"] or "[]"),
                    metadata=json.loads(m.get("metadata") or m.get("meta") or "{}"),
                    salience=m["salience"],
                    decay_lambda=m["decay_lambda"],
                    version=m["version"],
                    segment=m["segment"],
                    simhash=m["simhash"],
                    generated_summary=m["generated_summary"],
                    user_id=m.get("user_id"),
                    feedback_score=m.get("feedback_score") or 0.0,
                    _debug=None,
                )
                res.append(item)
            except Exception as e:
                logger.warning(f"skipping history item {r.get('id')}: {e}")
        return res

    async def list_users(self) -> List[str]:
        """
        List all active user IDs in the system.

        Returns:
            List[str]: A list of unique user IDs.
        """
        rows = await q.get_active_users()
        return [r["user_id"] for r in rows if r["user_id"]]

    async def stats(self, user_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Get statistics for the memory store.

        Args:
            user_id (Optional[str]): Filter stats by user. Defaults to `self.default_user`.

        Returns:
            Dict[str, Any]: Dictionary containing 'total_memories', 'sectors' distribution, etc.
        """
        uid = user_id or self.default_user
        rows = await q.get_stats(uid)

        total = 0
        sectors = {}
        for r in rows:
            s = r["primary_sector"] or "unknown"
            c = r["count"]
            sectors[s] = c
            total += c

        return {
            "total_memories": total,
            "sectors": sectors,
            "user_id": uid
        }

    async def rotate_key(self, user_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Re-encrypt all memories for a user with the current primary key.
        Useful after updating OM_ENCRYPTION_KEY and moving the old key to OM_ENCRYPTION_SECONDARY_KEYS.
        """
        provider = get_encryption()
        if not provider.enabled:
            return {"success": False, "message": "Encryption is not enabled."}
            
        # 1. Fetch all memories for the user
        uid = user_id or self.default_user or "anonymous"
        
        # Using a very large limit for now to ensure all items are covered
        mems = await q.all_mem(limit=1000000, user_id=uid)
        
        count = 0
        async with db.transaction():
            for m in mems:
                # Re-encrypt content
                old_content = m.get("content")
                if old_content:
                    new_content = provider.re_encrypt(old_content)
                    if new_content != old_content:
                        # Update without commit to stay in transaction
                        await q.upd_mem(m["id"], new_content, m["tags"], m["metadata"], int(time.time()*1000), user_id=uid, commit=False)
                        count += 1
        
        return {"success": True, "rotated_count": count}

    async def getAll(
        self, limit: int = 100, offset: int = 0, user_id: Optional[str] = None
    ) -> List[MemoryItem]:
        """
        Retrieve all memories. Alias for `history()` for Parity with JS SDK.

        Args:
            limit (int): Max items.
            offset (int): Offset.
            user_id (Optional[str]): User ID.

        Returns:
            List[MemoryItem]: List of memories.
        """
        return await self.history(user_id=user_id, limit=limit, offset=offset)

    async def getBySector(
        self, sector: str, limit: int = 100, user_id: Optional[str] = None
    ) -> List[MemoryItem]:
        """
        Retrieve memories specific to a cognitive sector.

        Args:
            sector (str): The sector name (e.g., 'episodic').
            limit (int): Max items.
            user_id (Optional[str]): User ID.

        Returns:
            List[MemoryItem]: List of memories in that sector.
        """
        uid = user_id or self.default_user
        rows = await q.all_mem_by_sector(sector, limit, 0, uid)

        enc = get_encryption()
        items = []
        for r in rows:
            m = dict(r)
            if "content" in m and enc:
                try:
                    m["content"] = enc.decrypt(m["content"])
                except:
                    pass
            # Map sector fields if needed, but MemoryItem handles it
            items.append(MemoryItem(**m))
        return items

    def list_sectors(self) -> List[str]:
        """
        Get a list of available cognitive sectors.

        Returns:
            List[str]: List of sector names.
        """
        return ["semantic", "episodic", "procedural", "emotional", "reflective"]

    async def close(self):
        """Close the database connection and release resources."""
        await db.disconnect()

    def source(self, name: str):
        """
        Get a pre-configured source connector instance.

        Args:
            name (str): The name of the source (e.g., 'github', 'notion').

        Returns:
            BaseConnector: An instance of the requested connector.

        Raises:
            ValueError: If the source name is unknown.
        """
        from . import connectors

        sources = {
            "github": connectors.GithubConnector,
            "notion": connectors.NotionConnector,
            "google_drive": connectors.GoogleDriveConnector,
            "google_sheets": connectors.GoogleSheetsConnector,
            "google_slides": connectors.GoogleSlidesConnector,
            "onedrive": connectors.OneDriveConnector,
            "web_crawler": connectors.WebCrawlerConnector,
        }

        if name not in sources:
            raise ValueError(f"unknown source: {name}. available: {list(sources.keys())}")

        return sources[name](user_id=self.default_user)

    @property
    def compression(self):
        """Access the vector compression engine."""
        from .ops.compress import compression_engine
        return compression_engine

    @property
    def temporal(self):
        """
        Access the Temporal Knowledge Graph facade.

        Returns:
            TemporalFacade: An object exposing methods for facts and edges.
        """
        from .temporal_graph import (
            insert_fact, get_current_fact, search_facts, get_facts_by_subject
        )

        class TemporalFacade:
            """Facade for Temporal Knowledge Graph operations."""

            def __init__(self, user_id):
                self.user_id = user_id

            async def add(self, subject: str, predicate: str, object_: str, **kwargs):
                """Add a new fact to the temporal graph."""
                # mapped to insert_fact
                kwargs.pop("commit", None) # Remove legacy arg if present
                return await insert_fact(subject, predicate, object_, user_id=self.user_id, **kwargs)

            async def get(self, subject: str, predicate: str):
                """Get the current valid fact for a subject-predicate pair."""
                return await get_current_fact(subject, predicate, user_id=self.user_id)

            async def search(self, pattern: str, limit: int = 100):
                """Search facts by pattern."""
                return await search_facts(pattern, limit=limit, user_id=self.user_id)

            async def history(self, subject: str):
                """Get history of facts for a subject."""
                return await get_facts_by_subject(subject, user_id=self.user_id)

            async def add_edge(self, source_id: str, target_id: str, relation: str, **kwargs):
                """Add an edge between two facts."""
                from .temporal_graph.store import insert_edge
                return await insert_edge(source_id, target_id, relation, user_id=self.user_id, **kwargs)

            async def get_edges(
                self, source_id: Optional[str] = None, target_id: Optional[str] = None
            ):
                """Retrieve edges connected to a source or target fact."""
                from .temporal_graph.query import get_related_facts
                if source_id:
                    return await get_related_facts(source_id, user_id=self.user_id)
                return []

        return TemporalFacade(self.default_user)

    @property
    def users(self):
        """Access User Management (Local Mode Stub)."""
        class UsersFacade:
            def __init__(self, user_id): self.user_id = user_id
            
            async def get_user(self, user_id): raise NotImplementedError("User management is only available in Remote mode.")
            async def register_user(self, user_id, scope="user"): raise NotImplementedError("User registration is only available in Remote mode.")
            async def list_api_keys(self): raise NotImplementedError("API Key management is only available in Remote mode.")
            async def revoke_api_key(self, prefix): raise NotImplementedError("API Key management is only available in Remote mode.")
            # Basic memory deletion is supported via delete_all
        return UsersFacade(self.default_user)

    @property
    def ide(self):
        """Access IDE Integration (Local Mode Stub)."""
        class IdeFacade:
            def __init__(self, user_id): self.user_id = user_id

            async def start_ide_session(self, **kwargs): raise NotImplementedError("IDE Integration is only available in Remote mode.")
            async def send_ide_event(self, **kwargs): raise NotImplementedError("IDE Integration is only available in Remote mode.")
            async def get_ide_context(self, **kwargs): raise NotImplementedError("IDE Integration is only available in Remote mode.")
        return IdeFacade(self.default_user)

    @property
    def dynamics(self):
        """Access Cognitive Dynamics (Local Mode Partial)."""
        from .ops import dynamics as dyn

        class DynamicsFacade:
            def __init__(self, user_id): self.user_id = user_id

            async def calculate_resonance(self, memory_sector="semantic", query_sector="semantic", base_similarity=0.8):
                return {"score": await dyn.calculateCrossSectorResonanceScore(memory_sector, query_sector, base_similarity)}
            
            async def reinforce_trace(self, memory_id):
                # We can implement a basic version of this locally
                m = await q.get_mem(memory_id)
                if not m: raise ValueError("Memory not found")
                new_sal = await dyn.applyRetrievalTraceReinforcementToMemory(memory_id, m["salience"])
                # Update DB
                # Note: This is a simplified update, ideally we use a proper update method
                await q.upd_mem_salience(memory_id, new_sal) 
                return {"success": True, "newSalience": new_sal}

            async def calculate_salience(self, **kwargs):
                # Fallback / Not implemented locally
                logger.warning("calculate_salience called locally but not implemented. Returning heuristic.")
                return {"salience": kwargs.get("initialSalience", 0.5)}

            async def spreading_activation(self, **kwargs): raise NotImplementedError("Spreading activation is complex and currently Remote-only.")

        return DynamicsFacade(self.default_user)

    @property
    def lgm(self):
        """Access LangGraph Memory (Local Mode Stub)."""
        class LangGraphFacade:
            def __init__(self, user_id): self.user_id = user_id
            
            async def get_lg_config(self): raise NotImplementedError("LangGraph Integration is only available in Remote mode.")
            async def store(self, **kwargs): raise NotImplementedError("LangGraph Integration is only available in Remote mode.")
            async def retrieve(self, **kwargs): raise NotImplementedError("LangGraph Integration is only available in Remote mode.")
            async def context(self, **kwargs): raise NotImplementedError("LangGraph Integration is only available in Remote mode.")
            async def reflect(self, **kwargs): raise NotImplementedError("LangGraph Integration is only available in Remote mode.")

        return LangGraphFacade(self.default_user)

    @property
    def sources(self):
        """Access Sources/Connectors (Local Mode Stub)."""
        from .ops import ingest as ing

        class SourcesFacade:
            def __init__(self, user_id, mem_instance): 
                self.user_id = user_id
                self.mem = mem_instance

            async def list_sources(self): 
                # Basic implementations available locally
                return {"sources": ["file", "url", "github", "google_drive", "notion"]}

            async def ingest_source(self, source, **kwargs): 
                raise NotImplementedError("Full source ingestion pipeline is optimized for Remote/Server mode.")
            
            async def get_source_configs(self): raise NotImplementedError("Source management is Remote-only.")
            async def set_source_config(self, **kwargs): raise NotImplementedError("Source management is Remote-only.")

        return SourcesFacade(self.default_user, self)

    async def ingest_url(self, url: str, user_id: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None):
        """Ingest content from a URL (Local Mode)."""
        from .ops.ingest import ingest_url
        uid = user_id or self.default_user
        # Delegate to ops.ingest
        return await ingest_url(url, meta=metadata, user_id=uid)


def run_mcp():
    """Run the Model Context Protocol (MCP) server."""
    import asyncio
    from .ai.mcp import run_mcp_server
    try:
        asyncio.run(run_mcp_server())
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "serve":
        from .server import start_server
        start_server()
    elif len(sys.argv) > 1 and sys.argv[1] == "mcp":
        run_mcp()
    else:
        print("OpenMemory Python SDK")
        print("Usage: python -m openmemory.main [serve|mcp]")
