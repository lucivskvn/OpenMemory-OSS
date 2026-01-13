from fastapi import APIRouter, Depends, HTTPException, Request
from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field
from ...main import Memory
from ...core.types import MemoryItem, AddRequest, IngestRequest, QueryRequest, ReinforceRequest, BatchAddRequest
from ..dependencies import get_current_user_id, resolve_user

router = APIRouter()
mem_client = Memory()

@router.post("/add", response_model=MemoryItem, response_model_by_alias=True)
async def add_memory(req: AddRequest, auth_user: str = Depends(get_current_user_id)):
    uid = resolve_user(auth_user, req.userId)
    return await mem_client.add(
        req.content, user_id=uid, tags=req.tags, meta=req.metadata
    )

@router.post("/batch")
async def add_batch_memories(req: BatchAddRequest, auth_user: str = Depends(get_current_user_id)):
    uid = resolve_user(auth_user, req.userId)
    items = [item.model_dump() for item in req.items]
    return await mem_client.add_batch(items, user_id=uid)

@router.post("/ingest")
async def ingest_memory(req: IngestRequest, auth_user: str = Depends(get_current_user_id)):
    # Map to mem_client.add or pipelines
    # For now, just simplistic wrapper around add if text, but proper ingest takes type
    from ...ops.ingest import ingest_document
    uid = resolve_user(auth_user, req.userId)
    # Ingest document returns dict not MemoryItem
    res = await ingest_document(
        req.contentType, req.data, meta=req.metadata, user_id=uid
    )
    return res

@router.post("/query", response_model=List[MemoryItem], response_model_by_alias=True)
async def query_memory(req: QueryRequest, auth_user: str = Depends(get_current_user_id)):
    uid = resolve_user(auth_user, req.userId)
    res = await mem_client.search(req.query, user_id=uid, limit=req.limit, **req.filters)
    return res

@router.post("/reinforce")
async def reinforce_memory(req: ReinforceRequest, auth_user: str = Depends(get_current_user_id)):
    uid = resolve_user(auth_user, req.userId)
    try:
        res = await mem_client.reinforce(req.id, boost=req.boost, user_id=uid)
        return res
    except ValueError:
        raise HTTPException(status_code=404, detail="Memory not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{id}", response_model=MemoryItem, response_model_by_alias=True)
async def get_memory(
    id: str, userId: Optional[str] = None, auth_user: str = Depends(get_current_user_id)
):
    uid = resolve_user(auth_user, userId)
    item = await mem_client.get(id, user_id=uid)  # type: ignore[call-arg]
    if not item:
        raise HTTPException(status_code=404, detail="Memory not found")
    return item


@router.delete("/{id}")
async def delete_memory(
    id: str, userId: Optional[str] = None, auth_user: str = Depends(get_current_user_id)
):
    try:
        uid = resolve_user(auth_user, userId)
        await mem_client.delete(id, user_id=uid)  # type: ignore[call-arg]
        return {"status": "ok"}
    except PermissionError:
        raise HTTPException(status_code=403, detail="Access denied")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/all", response_model=Dict[str, List[MemoryItem]], response_model_by_alias=True)
async def list_memories(
    limit: int = 100,
    offset: int = 0,
    userId: Optional[str] = None,
    auth_user: str = Depends(get_current_user_id),
):
    uid = resolve_user(auth_user, userId)
    # Use all() method which exists
    items = await mem_client.all(user_id=uid, limit=limit, offset=offset)  # type: ignore[call-arg]
    return {"items": items}


@router.patch("/{id}", response_model=MemoryItem, response_model_by_alias=True)
async def update_memory(id: str, req: Dict[str, Any], auth_user: str = Depends(get_current_user_id)): # Simple dict for patch
    # Extract fields
    content = req.get("content")
    tags = req.get("tags")
    meta = req.get("metadata")
    target_uid = req.get("userId") or req.get("user_id")
    uid = resolve_user(auth_user, target_uid)

    try:
        item = await mem_client.update(id, content=content, tags=tags, metadata=meta, user_id=uid)  # type: ignore[call-arg]
        return item
    except ValueError:
        raise HTTPException(status_code=404, detail="Memory not found")
    except PermissionError:
        raise HTTPException(status_code=403, detail="Access denied")
