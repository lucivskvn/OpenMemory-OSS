from fastapi import APIRouter, HTTPException, Depends, Body
from typing import Dict, Any, List, Optional
from pydantic import BaseModel
from ...main import Memory
from ...ai.graph import store_node_mem, get_graph_ctx, LgmStoreReq, LgmContextReq, LgmRetrieveReq, LgmReflectionReq

router = APIRouter(tags=["langgraph"])

@router.get("/config")
async def get_lg_config(memory: Memory = Depends(lambda: Memory())):
    """Get LGM Config."""
    # Assuming helper exists in graph.py (added in Phase 14)
    from ...ai.graph import get_lg_cfg
    return get_lg_cfg()

@router.post("/store")
async def lg_store(req: LgmStoreReq):
    """Store LGM memory."""
    res = await store_node_mem(req)
    return res.dict()

@router.post("/retrieve")
async def lg_retrieve(req: LgmRetrieveReq):
    """Retrieve LGM memories."""
    from ...ai.graph import retrieve_node_mems
    res = await retrieve_node_mems(req)
    return res.dict()

@router.post("/context")
async def lg_context(req: LgmContextReq):
    """Get distilled context."""
    res = await get_graph_ctx(req)
    return res.dict()

@router.post("/reflection")
async def lg_reflect(req: LgmReflectionReq):
    """Trigger reflection."""
    from ...ai.graph import create_refl
    res = await create_refl(req)
    return res.dict()
