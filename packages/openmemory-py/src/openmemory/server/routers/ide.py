import time
import uuid
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
from ...main import Memory
from ...core.types import MemoryItem, IdeContextRequest, IdeEventRequest
from ..dependencies import get_current_user_id, resolve_user
from ...ai import ide

router = APIRouter()
mem_client = Memory()


class SessionStartRequest(BaseModel):
    project_name: str = Field("unknown", alias="projectName")
    ide_name: str = Field("unknown", alias="ideName")
    user_id: Optional[str] = Field(None, alias="userId")


class SessionEndRequest(BaseModel):
    session_id: str = Field(..., alias="sessionId")
    user_id: Optional[str] = Field(None, alias="userId")


@router.post("/events")
async def log_event(req: IdeEventRequest, auth_user: str = Depends(get_current_user_id)):
    try:
        uid = resolve_user(auth_user, req.user_id)
        # Handle event type with alias or name logic if needed
        # IdeEventRequest.event is literal, IdeEventRequest.event_type alias?
        # In types.py I defined 'event' field with Literal. 
        # But `log_ide_event` expects `event_type`.
        # I should map req.event to event_type.
        return await ide.log_ide_event(
            event_type=req.event, # types.py uses 'event'
            file_path=req.file,   # types.py uses 'file'
            content=req.snippet or req.comment or "", # types.py uses snippet/comment
            language=req.metadata.lang or "text",
            session_id=req.session_id,
            metadata=req.metadata.model_dump(),
            user_id=uid,
            client=mem_client
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/context")
async def get_context(req: IdeContextRequest, auth_user: str = Depends(get_current_user_id)):
    try:
        uid = resolve_user(auth_user, req.user_id)
        return await ide.get_ide_context(
            query=req.query,
            limit=req.limit,
            session_id=req.session_id,
            file_path=req.file_path,
            user_id=uid,
            client=mem_client
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/session/start")
async def start_session(req: SessionStartRequest, auth_user: str = Depends(get_current_user_id)):
    try:
        uid = resolve_user(auth_user, req.user_id)
        return await ide.start_ide_session(
            project_name=req.project_name,
            ide_name=req.ide_name,
            user_id=uid,
            client=mem_client
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/session/end")
async def end_session(req: SessionEndRequest, auth_user: str = Depends(get_current_user_id)):
    try:
        uid = resolve_user(auth_user, req.user_id)
        return await ide.end_ide_session(
            session_id=req.session_id,
            user_id=uid,
            client=mem_client
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/patterns/{session_id}")
async def get_patterns(session_id: str, user_id: Optional[str] = None, auth_user: str = Depends(get_current_user_id)):
    try:
        uid = resolve_user(auth_user, user_id)
        return await ide.get_ide_patterns(
            session_id=session_id,
            user_id=uid,
            client=mem_client
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
