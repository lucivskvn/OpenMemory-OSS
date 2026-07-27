from fastapi import APIRouter, HTTPException, Body, Request
from typing import List, Dict, Any, Optional
import logging
from pydantic import BaseModel
from ...main import Memory

logger = logging.getLogger("server.memory")
mem = Memory()

router = APIRouter()

class AddMemoryRequest(BaseModel):
    content: str
    user_id: Optional[str] = None
    tags: Optional[List[str]] = []
    metadata: Optional[Dict[str, Any]] = {}

class SearchMemoryRequest(BaseModel):
    query: str
    user_id: Optional[str] = None
    limit: Optional[int] = 10
    filters: Optional[Dict[str, Any]] = {}

@router.post("/add", responses={500: {"description": "Internal Server Error"}})
async def add_memory(req: AddMemoryRequest, request: Request):
    tenant = getattr(request.state, "tenant", "anonymous")
    user_id = req.user_id
    if user_id:
        if user_id != tenant:
            raise HTTPException(status_code=403, detail="tenant_mismatch")
    else:
        user_id = tenant

    try:
        meta = req.metadata or {}
        if req.tags:
            meta["tags"] = req.tags

        result = await mem.add(req.content, user_id=user_id, meta=meta)
        return {"success": True, "data": result}
    except Exception:
        logger.exception("Error adding memory")
        raise HTTPException(status_code=500, detail="Failed to add memory") from None

@router.post("/search", responses={500: {"description": "Internal Server Error"}})
async def search_memory(req: SearchMemoryRequest, request: Request):
    tenant = getattr(request.state, "tenant", "anonymous")
    user_id = req.user_id
    if user_id:
        if user_id != tenant:
            raise HTTPException(status_code=403, detail="tenant_mismatch")
    else:
        user_id = tenant

    try:
        filters = {k: v for k, v in (req.filters or {}).items() if k != "user_id"}
        results = await mem.search(req.query, user_id=user_id, limit=req.limit, **filters)
        return {"results": results}
    except Exception:
        logger.exception("Error searching memory")
        raise HTTPException(status_code=500, detail="Failed to search memory") from None

@router.get("/history", responses={500: {"description": "Internal Server Error"}})
async def get_history(user_id: str, request: Request, limit: int = 20, offset: int = 0):
    tenant = getattr(request.state, "tenant", "anonymous")
    if user_id != tenant:
        raise HTTPException(status_code=403, detail="tenant_mismatch")

    try:
        results = mem.history(user_id, limit, offset)
        return {"history": results}
    except Exception:
        logger.exception("Error fetching memory history")
        raise HTTPException(status_code=500, detail="Failed to fetch memory history") from None
