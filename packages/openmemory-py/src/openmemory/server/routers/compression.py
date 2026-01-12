from fastapi import APIRouter, HTTPException, Depends, Body
from typing import Dict, Any, List, Optional
from pydantic import BaseModel
from ...ops.compress import compression_engine
from ...core.types import CompressionResult, CompressionStats

router = APIRouter(tags=["compression"])

class CompressRequest(BaseModel):
    text: str
    algorithm: str = "semantic"

@router.post("/test")
async def test_compression(req: CompressRequest):
    """
    Test compression algorithm on input text.
    """
    try:
        if req.algorithm == "auto":
            res = compression_engine.auto(req.text)
        else:
            res = compression_engine.compress(req.text, req.algorithm)
        
        return {"success": True, "result": res}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/stats")
async def get_compression_stats():
    """
    Get compression engine statistics.
    """
    stats = compression_engine.get_stats()
    return {"success": True, "stats": stats}
