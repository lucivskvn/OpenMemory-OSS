import time
import uuid
import logging
from typing import Optional, Dict, List, Any
from ..main import Memory
from ..core.types import MemoryItem

logger = logging.getLogger(__name__)

# Singleton client for internal usage (or pass in?)
# Better to instantiate per request or use shared instance.
# For simplicity in this module, we instantiate locally or accept as arg?
# The router uses specialized client. MCP uses local Memory().
# We should accept client or create new.
# Let's use `Memory()` (backend default) if not provided.

async def log_ide_event(
    event_type: str,
    file_path: str,
    content: Optional[str] = None,
    language: Optional[str] = "text",
    session_id: str = "default",
    metadata: Dict[str, Any] = {},
    user_id: Optional[str] = None,
    client: Optional[Memory] = None
) -> Dict[str, Any]:
    """
    Log an IDE event (open, save, close, etc.) to memory.
    """
    mem_client = client or Memory() 
    # Note: Memory() in python SDK (client.py) connects via HTTP usually?
    # Wait, `from ...main import Memory` in router imports the SERVER-SIDE implementation!
    # Yes, router imports `from ...main import Memory`.
    # MCP imports `from ..main import Memory` too.
    # So both are server-side. Good.
    
    if event_type == "open":
        mem_content = f"Opened file: {file_path}"
    elif event_type == "save":
        mem_content = (
            f"Saved file: {file_path}\n\n{content}"
            if content
            else f"Saved file: {file_path}"
        )
    elif event_type == "close":
        mem_content = f"Closed file: {file_path}"
    else:
        mem_content = f"[{event_type}] {file_path}\n{content}".strip()

    full_metadata = {
        **metadata,
        "ide_event_type": event_type,
        "ide_file_path": file_path,
        "ide_language": language,
        "ide_session_id": session_id,
        "ide_timestamp": int(time.time() * 1000),
        "ide_mode": True,
    }

    res = await mem_client.add(mem_content, user_id=user_id, meta=full_metadata)

    return {
        "success": True,
        "memoryId": res.id,
        "primarySector": res.primary_sector,
    }

async def get_ide_context(
    query: str,
    limit: int = 5,
    session_id: Optional[str] = None,
    file_path: Optional[str] = None,
    user_id: Optional[str] = None,
    client: Optional[Memory] = None
) -> Dict[str, Any]:
    """
    Retrieve context relevant to the current IDE state.
    """
    mem_client = client or Memory()
    
    results = await mem_client.search(
        query, user_id=user_id, limit=limit * 2
    )

    filtered = []
    for r in results:
        meta = getattr(r, "meta", None) or getattr(r, "metadata", {}) or {}
        
        if session_id:
            if meta.get("ide_session_id") != session_id:
                continue

        if file_path:
            path_in_meta = meta.get("ide_file_path", "") or meta.get("file_path", "")
            if (
                file_path.lower() not in r.content.lower()
                and file_path.lower() not in path_in_meta.lower()
            ):
                continue

        filtered.append(r)

    filtered = filtered[:limit]

    formatted = [
        {
            "memoryId": r.id,
            "content": r.content,
            "primarySector": r.primary_sector,
            "salience": r.salience,
            "score": r.score,
            "lastSeenAt": getattr(r, "last_accessed", None) or r.last_seen_at,
        }
        for r in filtered
    ]

    return {
        "success": True,
        "context": formatted,
        "total": len(formatted),
        "query": query,
    }

async def start_ide_session(
    project_name: str,
    ide_name: str,
    user_id: Optional[str] = None,
    client: Optional[Memory] = None
) -> Dict[str, Any]:
    mem_client = client or Memory()
    
    session_id = f"session_{int(time.time())}_{uuid.uuid4().hex[:8]}"
    content = f"Session started: {user_id or 'unknown'} in {project_name} using {ide_name}"

    metadata = {
        "ide_session_id": session_id,
        "ide_project_name": project_name,
        "ide_name": ide_name,
        "session_start_time": int(time.time() * 1000),
        "session_type": "ide_session",
        "ide_mode": True
    }

    res = await mem_client.add(content, user_id=user_id, meta=metadata)

    return {
        "success": True,
        "sessionId": session_id,
        "memoryId": res.id,
        "startedAt": metadata["session_start_time"],
    }

async def end_ide_session(
    session_id: str,
    user_id: Optional[str] = None,
    client: Optional[Memory] = None
) -> Dict[str, Any]:
    mem_client = client or Memory()
    
    content = f"Session {session_id} ended."
    metadata = {
        "ide_session_id": session_id,
        "session_end_time": int(time.time() * 1000),
        "session_type": "ide_session_end",
        "ide_mode": True,
    }

    res = await mem_client.add(content, user_id=user_id, meta=metadata)

    return {
        "success": True,
        "sessionId": session_id,
        "endedAt": metadata["session_end_time"],
    }

async def get_ide_patterns(
    session_id: Optional[str] = None,
    active_files: List[str] = [],
    user_id: Optional[str] = None,
    client: Optional[Memory] = None
) -> Dict[str, Any]:
    """
    Retrieve active patterns relevant to the current IDE session or file context.
    Aligns with JS implementation by prioritizing 'active_files' context.
    """
    mem_client = client or Memory()
    
    # search for generic coding patterns first
    results = await mem_client.search(
        "coding pattern implementation best practice", user_id=user_id, limit=20
    )

    patterns = []
    for r in results:
        meta = getattr(r, "meta", None) or getattr(r, "metadata", {}) or {}
        
        # Filter by sector
        if r.primary_sector != "procedural":
            continue
            
        # If session_id provided, filter strict
        if session_id and session_id != "default" and meta.get("ide_session_id") != session_id:
            continue
            
        # If active_files provided, check relevance
        affected = meta.get("affected_files", []) or [meta.get("ide_file_path", "")]
        is_relevant = False
        
        if not active_files and not session_id:
            # If no context provided, return generic high-salience patterns
            is_relevant = True
        elif active_files:
            # Check overlap or string match
            for af in active_files:
                for aff in affected:
                    if aff and (aff in af or af in aff):
                        is_relevant = True
                        break
                if is_relevant: break
        elif session_id:
            # Handled above
            is_relevant = True
            
        if is_relevant:
            patterns.append(
                {
                    "patternId": r.id,
                    "description": r.content,
                    "salience": r.salience,
                    "detectedAt": r.created_at,
                    "lastReinforced": r.updated_at,
                    "confidence": r.salience,
                    "affectedFiles": affected
                }
            )

    return {
        "success": True,
        "sessionId": session_id,
        "patternCount": len(patterns),
        "patterns": patterns
    }
