import logging
from typing import List, Dict, Optional, Any
import json
import asyncio

from .core.db import db, q
from .memory.hsg import hsg_query, add_hsg_memory
from .core.security import get_encryption
from .ops.ingest import ingest_document
from .openai_handler import OpenAIRegistrar
from .core.types import MemoryItem
from .core.config import env

__version__ = "2.1.0"

logger = logging.getLogger("openmemory")

class Memory:
    def __init__(self, user: str = None, **kwargs):
        """
        Initialize the Memory client.
        
        Args:
            user (str, optional): Default user ID for operations.
            path (str, optional): Path to SQLite database file.
            url (str, optional): Connection URL for Postgres or SQLite.
            api_key (str, optional): OpenAI API key override.
            tier (str, optional): Performance tier ('fast', 'smart', 'deep', 'hybrid').
            embeddings (dict | str, optional): Embeddings configuration override.
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
        return self._openai

    async def add(self, content: str, user_id: str = None, **kwargs) -> MemoryItem:
        """
        Add a new memory with automated classification and embedding.
        
        Args:
            content (str): The text content to remember.
            user_id (str, optional): The user ID (defaults to client default).
            **kwargs: Additional metadata, tags, or memory options.
            
        Returns:
            MemoryItem: The created memory record.
            
        Raises:
            ValueError: If memory creation fails or ID is missing.
            RuntimeError: If memory is not found after creation (consistency check).
        """
        uid = user_id or self.default_user
        res = await ingest_document("text", content, meta=kwargs.get("meta"), user_id=uid, tags=kwargs.get("tags"))
        
        mid = res.get("root_memory_id") or res.get("id")
        if not mid:
            raise ValueError("Failed to create memory: no ID returned")
            
        # Retry get() a few times to handle potential race/consistency lag (e.g. WAL)
        for _ in range(3):
            item = await self.get(mid, user_id=uid)
            if item: return item
            await asyncio.sleep(0.05)
            
        raise RuntimeError(f"Memory {mid} created but not found")

    async def search(self, query: str, user_id: str = None, limit: int = 10, **kwargs) -> List[MemoryItem]:
        """
        Search memories using hybrid semantic and keyword retrieval.
        
        Args:
            query (str): The search query text.
            user_id (str, optional): The user ID scope.
            limit (int, optional): Maximum number of results. Defaults to 10.
            **kwargs: Additional filters (e.g., sectors, tags).
            
        Returns:
            List[MemoryItem]: Ranked list of matching memories.
        """
        uid = user_id or self.default_user
        filters = kwargs.copy()
        filters["user_id"] = uid
        return await hsg_query(query, limit, filters)

    async def get(self, memory_id: str, user_id: str = None) -> Optional[MemoryItem]:
        """
        Retrieve a memory by its ID.
        
        Args:
            memory_id (str): The unique memory ID.
            user_id (str, optional): The user ID for ownership validation.
            
        Returns:
            Optional[MemoryItem]: The memory item if found and authorized, else None.
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
                    meta=json.loads(m["meta"] or "{}"),
                    salience=m["salience"],
                    user_id=m["user_id"],
                    feedback_score=m.get("feedback_score") or 0.0
                )
            except Exception as e:
                logger.error(f"failed to decrypt/parse memory {memory_id}: {e}")
        return None
        
    async def update(self, memory_id: str, content: Optional[str] = None, tags: Optional[List[str]] = None, metadata: Optional[Dict[str, Any]] = None, user_id: str = None) -> MemoryItem:
        """
        Update an existing memory with new content, tags, or metadata.
        
        Args:
            memory_id (str): The ID of the memory to update.
            content (str, optional): New text content.
            tags (List[str], optional): New list of tags (replaces existing).
            metadata (Dict[str, Any], optional): New metadata (merges/replaces).
            user_id (str, optional): The user ID scope.
            
        Returns:
            MemoryItem: The updated memory item.
            
        Raises:
            ValueError: If memory is not found.
            PermissionError: If user_id does not own the memory.
        """
        uid = user_id or self.default_user
        # Check ownership
        m = await q.get_mem(memory_id)
        if not m:
            raise ValueError(f"Memory {memory_id} not found")
        if uid and m.get("user_id") and m.get("user_id") != uid:
            raise PermissionError("Access denied")
            
        from .memory.hsg import update_memory as _update
        await _update(memory_id, content, tags, metadata)
        
        item = await self.get(memory_id, user_id=uid)
        return item

    async def reinforce(self, memory_id: str, boost: float = 0.1, user_id: str = None):
        """
        Boost the salience of a memory, making it more likely to be retrieved.
        
        Args:
            memory_id (str): The ID of the memory to reinforce.
            boost (float, optional): The amount to increase salience by. Defaults to 0.1.
            user_id (str, optional): The user ID scope.
            
        Raises:
            ValueError: If memory not found.
            PermissionError: If access denied.
        """
        uid = user_id or self.default_user
        m = await q.get_mem(memory_id)
        if not m:
            raise ValueError(f"Memory {memory_id} not found")
        if uid and m.get("user_id") and m.get("user_id") != uid:
            raise PermissionError("Access denied")
            
        from .memory.hsg import reinforce_memory as _reinforce
        await _reinforce(memory_id, boost)

    async def delete(self, memory_id: str, user_id: str = None):
        """
        Delete a memory by its ID.
        
        Args:
            memory_id (str): The ID of the memory to delete.
            user_id (str, optional): The user ID scope (ownership check).
            
        Raises:
            PermissionError: If user_id does not own the memory.
        """
        uid = user_id or self.default_user
        # Check ownership before delete
        m = await q.get_mem(memory_id)
        if m and uid and m.get("user_id") and m.get("user_id") != uid:
            raise PermissionError("Access denied")
        await q.del_mem(memory_id, user_id=uid)

        
    async def delete_all(self, user_id: str = None):
        uid = user_id or self.default_user
        if uid:
            await q.del_mem_by_user(uid)
        
    async def history(self, user_id: str = None, limit: int = 20, offset: int = 0) -> List[MemoryItem]:
        """
        Retrieve chronological history of memories for a user.
        
        Args:
            user_id (str, optional): The user ID scope.
            limit (int, optional): Max records to return. Defaults to 20.
            offset (int, optional): Pagination offset.
            
        Returns:
            List[MemoryItem]: List of memories ordered by creation time.
        """
        uid = user_id or self.default_user
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
                    meta=json.loads(m["meta"] or "{}"),
                    salience=m["salience"],
                    user_id=m.get("user_id"),
                    feedback_score=m.get("feedback_score") or 0.0
                )
                res.append(item)
            except Exception as e:
                logger.warning(f"skipping history item {r.get('id')}: {e}")
        return res

    async def list_users(self) -> List[str]:
        """Returns a list of all user IDs present in the memory store."""
        rows = await q.get_active_users()
        return [r["user_id"] for r in rows if r["user_id"]]

    async def stats(self, user_id: str = None) -> Dict[str, Any]:
        """Returns storage statistics for the user or global if None."""
        uid = user_id or self.default_user
        rows = await q.all_mem(limit=1000000, user_id=uid)
        
        sectors = {}
        for r in rows:
             s = r.get("primary_sector", "unknown")
             sectors[s] = sectors.get(s, 0) + 1
             
        return {
            "total_memories": len(rows),
            "sectors": sectors,
            "user_id": uid
        }

    async def getAll(self, limit: int = 100, offset: int = 0, user_id: str = None) -> List[MemoryItem]:
        """
        Retrieve all memories. Alias for history() for JS SDK parity.
        """
        return await self.history(user_id=user_id, limit=limit, offset=offset)

    async def getBySector(self, sector: str, limit: int = 100, user_id: str = None) -> List[MemoryItem]:
        """
        Retrieve memories from a specific cognitive sector.
        """
        uid = user_id or self.default_user
        rows = await q.all_mem_by_sector(sector, uid)
        # Limit rows
        rows = rows[:limit]
        
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
        """Available cognitive sectors."""
        return ["semantic", "episodic", "procedural", "emotional", "reflective"]

    async def close(self):
        """Close the database connections."""
        await db.disconnect()

    def source(self, name: str):
        """
        get a pre-configured source connector.
        
        usage:
            github = mem.source("github")
            await github.connect(token="ghp_...")
            await github.ingest_all(repo="owner/repo")
        
        available sources: github, notion, google_drive, google_sheets, 
                          google_slides, onedrive, web_crawler
        """
        from . import connectors
        
        sources = {
            "github": connectors.github_connector,
            "notion": connectors.notion_connector,
            "google_drive": connectors.google_drive_connector,
            "google_sheets": connectors.google_sheets_connector,
            "google_slides": connectors.google_slides_connector,
            "onedrive": connectors.onedrive_connector,
            "web_crawler": connectors.web_crawler_connector,
        }
        
        if name not in sources:
            raise ValueError(f"unknown source: {name}. available: {list(sources.keys())}")
        
        return sources[name](user_id=self.default_user)

    @property
    def compression(self):
        from .ops.compress import compression_engine
        return compression_engine

    @property
    def temporal(self):
        from .temporal_graph import (
            insert_fact, get_current_fact, search_facts, get_facts_by_subject
        )
        
        class TemporalFacade:
            def __init__(self, user_id):
                self.user_id = user_id
                
            async def add(self, subject: str, predicate: str, object_: str, **kwargs):
                # mapped to insert_fact
                return await insert_fact(subject, predicate, object_, user_id=self.user_id, **kwargs)
                
            async def get(self, subject: str, predicate: str):
                return await get_current_fact(subject, predicate, user_id=self.user_id)
                
            async def search(self, pattern: str, limit: int = 100):
                return await search_facts(pattern, limit=limit, user_id=self.user_id)
                
            async def history(self, subject: str):
                return await get_facts_by_subject(subject, user_id=self.user_id)

            async def add_edge(self, source_id: str, target_id: str, relation: str, **kwargs):
                from .temporal_graph.store import insert_edge
                return await insert_edge(source_id, target_id, relation, user_id=self.user_id, **kwargs)

            async def get_edges(self, source_id: str = None, target_id: str = None):
                from .temporal_graph.query import get_related_facts
                if source_id:
                     return await get_related_facts(source_id, user_id=self.user_id)
                return []
                
        return TemporalFacade(self.default_user)

def run_mcp():
    import asyncio
    from .ai.mcp import run_mcp_server
    try:
        asyncio.run(run_mcp_server())
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "serve":
        # Legacy/Removed, but keep friendly message if user tries
        print("Server mode removed. Use 'mcp' for agentic usage.")
    elif len(sys.argv) > 1 and sys.argv[1] == "mcp":
        run_mcp()
    else:
        print("OpenMemory Python SDK")
        print("Usage: python -m openmemory.main mcp")
