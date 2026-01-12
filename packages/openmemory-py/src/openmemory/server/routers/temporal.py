from fastapi import APIRouter, Depends, HTTPException
from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field, ConfigDict
from ...main import Memory
from ...core.types import TemporalFact
from ..dependencies import get_current_user_id, resolve_user

router = APIRouter()
mem_client = Memory()

class FactRequest(BaseModel):
    subject: str
    predicate: str
    fact_object: str = Field(..., alias="object")
    valid_from: Optional[str] = Field(None, alias="validFrom")
    confidence: float = 1.0
    user_id: Optional[str] = Field(None, alias="userId")
    metadata: Dict[str, Any] = {}
    
    model_config = ConfigDict(populate_by_name=True)

class EdgeRequest(BaseModel):
    source_id: str = Field(..., alias="sourceId")
    target_id: str = Field(..., alias="targetId")
    relation_type: str = Field(..., alias="relationType")
    weight: float = 1.0
    user_id: Optional[str] = Field(None, alias="userId")

    model_config = ConfigDict(populate_by_name=True)

@router.post("/fact", response_model_by_alias=True)
async def create_fact(req: FactRequest, auth_user: str = Depends(get_current_user_id)):
    t = mem_client.temporal  # type: ignore[attr-defined]
    from ...temporal_graph import insert_fact
    uid = resolve_user(auth_user, req.user_id)
    valid_from_val = None
    if req.valid_from:
        if req.valid_from.isdigit():
            valid_from_val = int(req.valid_from)
        else:
            try:
                from dateutil import parser
                dt = parser.parse(req.valid_from)
                valid_from_val = int(dt.timestamp() * 1000)
            except Exception as e:
                import logging
                logging.getLogger("temporal").warning(f"Failed to parse date {req.valid_from}: {e}")

    fid = await insert_fact(
        req.subject, req.predicate, req.fact_object, 
        valid_from=valid_from_val,  # type: ignore[call-arg]
        confidence=req.confidence,
        metadata=req.metadata,
        user_id=uid  # type: ignore[call-arg]
    )
    return {"id": fid}

@router.get("/fact", response_model_by_alias=True)
async def get_facts_filtered(
    subject: Optional[str] = None,
    predicate: Optional[str] = None,
    object: Optional[str] = None,
    at: Optional[int] = None,
    minConfidence: Optional[float] = None,
    limit: int = 100,
    user_id: Optional[str] = None,
    auth_user: str = Depends(get_current_user_id)
):
    from ...temporal_graph import query_facts_at_time
    uid = resolve_user(auth_user, user_id)
    
    facts = await query_facts_at_time(
        subject=subject,
        predicate=predicate,
        fact_object=object,
        at=at,
        min_confidence=minConfidence or 0.0,  # type: ignore[call-arg]
        user_id=uid  # type: ignore[call-arg]
    )
    return {"facts": facts}

@router.get("/search", response_model_by_alias=True)
async def search_facts_pattern(
    pattern: Optional[str] = None, 
    q: Optional[str] = None,  # Support both
    type: str = "subject", 
    limit: int = 10, 
    user_id: Optional[str] = None, 
    auth_user: str = Depends(get_current_user_id)
):
    from ...temporal_graph import search_facts
    uid = resolve_user(auth_user, user_id)
    query_str = pattern or q
    if not query_str:
        return {"facts": []}

    # search_facts in query.py currently only supports pattern search (likely subject based)
    res = await search_facts(query_str, limit=limit, user_id=uid)  # type: ignore[call-arg]
    return {"facts": res}

@router.post("/edge", response_model_by_alias=True)
async def create_edge(req: EdgeRequest, auth_user: str = Depends(get_current_user_id)):
    from ...temporal_graph.store import insert_edge
    uid = resolve_user(auth_user, req.user_id)
    eid = await insert_edge(
        req.source_id, req.target_id, req.relation_type,
        weight=req.weight, user_id=uid  # type: ignore[call-arg]
    )
    return {"id": eid, "ok": True}

@router.get("/edge", response_model_by_alias=True)
async def get_edges_route(sourceId: Optional[str] = None, targetId: Optional[str] = None, relationType: Optional[str] = None, user_id: Optional[str] = None, auth_user: str = Depends(get_current_user_id)):
    from ...temporal_graph import query_edges
    uid = resolve_user(auth_user, user_id)
    edges = await query_edges(source_id=sourceId, target_id=targetId, relation_type=relationType, user_id=uid)  # type: ignore[call-arg]
    return {"edges": edges}

@router.get("/subject/{subject}", response_model_by_alias=True)
async def get_subject_facts(subject: str, user_id: Optional[str] = None, auth_user: str = Depends(get_current_user_id)):
    from ...temporal_graph.query import get_facts_by_subject
    uid = resolve_user(auth_user, user_id)
    facts = await get_facts_by_subject(subject, user_id=uid)  # type: ignore[call-arg]
    return {"facts": facts}

@router.get("/timeline", response_model_by_alias=True)
async def get_timeline_route(subject: str, user_id: Optional[str] = None, auth_user: str = Depends(get_current_user_id)):
    from ...temporal_graph import get_subject_timeline
    uid = resolve_user(auth_user, user_id)
    timeline = await get_subject_timeline(subject, user_id=uid)  # type: ignore[call-arg]
    return {"timeline": timeline}

@router.get("/history/predicate", response_model_by_alias=True)
async def get_predicate_history_route(predicate: str, user_id: Optional[str] = None, auth_user: str = Depends(get_current_user_id)):
    from ...temporal_graph import get_predicate_timeline
    uid = resolve_user(auth_user, user_id)
    timeline = await get_predicate_timeline(predicate, user_id=uid)  # type: ignore[call-arg]
    return {"timeline": timeline}
