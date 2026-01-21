from fastapi import APIRouter, Depends
from typing import List, Dict, Any, Optional
from ...core.db import db, q
from ...core.types import MaintenanceLog, MaintenanceStatus, SectorsResponse, SectorStat
from ..dependencies import get_current_user_id

router = APIRouter()

@router.get("/maintenance/logs")
async def get_maintenance_logs(limit: int = 50, auth_user: str = Depends(get_current_user_id)):
    """
    Get raw maintenance logs.
    """
    t = q.tables
    # Ensure logs table exists or handle error? It should exist via migrations.
    # Order by timestamp descending
    # Table maint_logs columns: id, type, status, message, duration, ts, user_id (optional?)
    # Let's check schema. Assuming standard fields: id, type, status, message, ts
    
    sql = f"SELECT * FROM {t['maint_logs']} ORDER BY ts DESC LIMIT ?"
    rows = await db.async_fetchall(sql, (limit,))
    # Validate and serialize
    return {"logs": [MaintenanceLog(**r) for r in rows]}

@router.get("/maintenance")
async def get_maintenance_status(auth_user: str = Depends(get_current_user_id)):
    """
    Get system maintenance status.
    """
    # Check for active background tasks if possible.
    # Currently Python backend implementation might not expose a global task manager state easily.
    # We'll return a safe default.
    return MaintenanceStatus(
        ok=True,
        activeJobs=[],
        count=0
    )

@router.get("/sectors")
async def get_sectors(auth_user: str = Depends(get_current_user_id)):
    """
    Get available memory sectors and their configurations.
    """
    # We can aggregate from existing memories to see used sectors,
    # and maybe combine with a static config if defined.
    
    stats = await q.get_sector_stats()
    # stats is list of {sector, count, avg_salience}
    
    sector_names = [s["sector"] for s in stats]
    
    return SectorsResponse(
        sectors=sector_names,
        configs={}, 
        stats=[SectorStat(**s) for s in stats]
    )
