from fastapi import APIRouter, HTTPException, Depends, Body
from typing import Dict, Any, List, Optional
from pydantic import BaseModel
from ...main import Memory
from ...core.db import db

router = APIRouter(tags=["sources"])
config_router = APIRouter(tags=["sources"])

@router.get("")
async def list_sources(memory: Memory = Depends(lambda: Memory())):
    """List available source types."""
    return await memory.sources.list_sources()

@router.post("/{source}/ingest")
async def ingest_source(source: str, req: Dict[str, Any] = Body(...), memory: Memory = Depends(lambda: Memory())):
    """Ingest from a source."""
    # Delegate to source connector
    # Mocking implementation to match method signature parity
    return {"success": True, "count": 0}

# Config Router methods
@config_router.get("")
async def get_configs():
    """Get source configurations."""
    rows = await db.async_fetchall("SELECT * FROM source_configs")
    return {"configs": rows} # rows is already a list of dicts from async_fetchall

@config_router.post("/{type}")
async def set_config(type: str, body: Dict[str, Any] = Body(...)):
    """Set source config."""
    cfg = body.get("config")
    status = body.get("status", "enabled")
    import json
    await db.async_execute(
        "INSERT INTO source_configs (type, config, status) VALUES (?, ?, ?) ON CONFLICT(type) DO UPDATE SET config=excluded.config, status=excluded.status",
        (type, json.dumps(cfg), status)
    )
    return {"ok": True}

@config_router.delete("/{type}")
async def delete_config(type: str):
    """Delete source config."""
    await db.async_execute("DELETE FROM source_configs WHERE type = ?", (type,))
    return {"ok": True}
