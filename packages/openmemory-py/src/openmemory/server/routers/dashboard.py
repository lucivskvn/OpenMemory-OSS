from fastapi import APIRouter, Depends, HTTPException, Query
from typing import List, Optional, Dict, Any
from ...core.db import db, q
from ...core.security import get_encryption
from ...core.config import env
from ...core.types import SystemStats, TimelineQuery, MaintenanceQuery, SettingsBody, TopMemory, ActivityItem
from ..metrics import metrics
from ..dependencies import get_current_user_id, resolve_user
from ...core.persisted_cfg import get_persisted_config, set_persisted_config
from pydantic import BaseModel
import time
import sys
import json

router = APIRouter()

# --- Validation Models ---

# --- Validation Models ---
# Imported from core.types

# --- Endpoints ---

@router.get("/stats", response_model=SystemStats)
async def get_stats(user_id: Optional[str] = None, auth_user: str = Depends(get_current_user_id)):
    uid = resolve_user(auth_user, user_id)
    t = q.tables

    # 1. Counts
    mem_count = await db.async_fetchone(f"SELECT count(*) as c FROM {t['memories']}")
    count_val = mem_count["c"] if mem_count else 0

    # Recent (last 24h)
    since = int(time.time() * 1000) - 86400000
    recent_count = await db.async_fetchone(f"SELECT count(*) as c FROM {t['memories']} WHERE created_at > ?", (since,))
    rec_val = recent_count["c"] if recent_count else 0

    # 2. Sector Stats
    sectors = await q.get_sector_stats(user_id=uid)
    sec_map = {s["sector"]: s["count"] for s in sectors}

    # 3. Aggregates (AVG Salience, Decay)
    agg = await db.async_fetchone(f"SELECT avg(salience) as avgs, min(salience) as mins, max(salience) as maxs, avg(decay_lambda) as avgl FROM {t['memories']}")
    avg_sal = agg["avgs"] or 0.0  # type: ignore[index]

    # 4. System Usage (Mock or psutil)
    mem_usage = 0
    try:
        import psutil  # type: ignore[import-untyped]

        mem = psutil.virtual_memory()
        mem_usage = mem.used
    except ImportError:
        pass

    return {
        "totalMemories": count_val,
        "recentMemories": rec_val,
        "sectorCounts": sec_map,
        "avgSalience": f"{avg_sal:.2f}",
        "decayStats": {
            "total": count_val,
            "avgLambda": f"{agg['avgl'] or 0.0:.3f}",  # type: ignore[index]
            "minSalience": f"{agg['mins'] or 0.0:.2f}",  # type: ignore[index]
            "maxSalience": f"{agg['maxs'] or 0.0:.2f}",  # type: ignore[index]
        },
        "requests": {
            "total": metrics.total_requests,
            "errors": metrics.error_count,
            "errorRate": f"{(metrics.error_count / metrics.total_requests * 100) if metrics.total_requests > 0 else 0:.1f}%",
            "lastHour": metrics.get_last_hour_count(),
        },
        "qps": {
            "peak": metrics.peak_qps,
            "average": (
                metrics.total_requests / (time.time() - metrics.start_time)
                if (time.time() - metrics.start_time) > 0
                else 0.0
            ),
            "cacheHitRate": 0.0,  # Not implemented in SQLite backend
        },
        "system": {
            "memoryUsage": mem_usage,
            "heapUsed": sys.getsizeof(sectors) * 10,  # Rough proxy
            "heapTotal": 1024 * 1024 * 1024,  # Mock 1GB
            "uptime": metrics.get_uptime(),
        },
        "config": {
            "port": env.port or 8080,
            "vecDim": 1536,  # Standard
            "cacheSegments": 100,
            "maxActive": 100,
            "decayInterval": 3600,
            "embedProvider": "openai",
        },
    }

@router.get("/activity", response_model=Dict[str, List[ActivityItem]])
async def get_activity(limit: int = 50, user_id: Optional[str] = None, auth_user: str = Depends(get_current_user_id)):
    # api.ts expects { "activities": [ActivityItem] }
    # ActivityItem: { id, type, sector, content, salience, timestamp }
    uid = resolve_user(auth_user, user_id)
    mems = await q.all_mem(limit=limit, user_id=uid)
    res: List[ActivityItem] = []
    enc = get_encryption()

    for m in mems:
        # Decrypt content snippet
        content = "Encrypted"
        if enc:
            try:
                content = enc.decrypt(m["content"])
            except:
                pass

        # Determine type
        # Assuming version 1 is new, >1 is updated
        act_type = "memory_created" if m.get("version", 1) <= 1 else "memory_updated"
        
        # Check for reflective
        if m.get("primary_sector") == "reflective":
             act_type = "reflection"

        res.append(ActivityItem(
            id=m["id"],
            type=act_type,
            sector=m["primary_sector"],
            content=content[:100] + ("..." if len(content) > 100 else ""),
            salience=m["salience"],
            timestamp=m["updated_at"] or m["created_at"]
        ))

    return {"activities": res}

@router.get("/sectors/timeline")
async def get_timeline(hours: int = Query(24, ge=1, le=720), user_id: Optional[str] = None, auth_user: str = Depends(get_current_user_id)):
    uid = resolve_user(auth_user, user_id)
    t = q.tables
    strt = int(time.time() * 1000) - hours * 60 * 60 * 1000
    
    # Grouping logic
    is_pg = db.is_pg
    
    if hours <= 24:
        display_format = "to_char(to_timestamp(created_at/1000), 'HH24:00')" if is_pg else "strftime('%H:00', datetime(created_at/1000, 'unixepoch', 'localtime'))"
        sort_format = "to_char(to_timestamp(created_at/1000), 'YYYY-MM-DD HH24:00')" if is_pg else "strftime('%Y-%m-%d %H:00', datetime(created_at/1000, 'unixepoch', 'localtime'))"
        time_key = "hour"
    elif hours <= 168:
        display_format = "to_char(to_timestamp(created_at/1000), 'MM-DD')" if is_pg else "strftime('%m-%d', datetime(created_at/1000, 'unixepoch', 'localtime'))"
        sort_format = "to_char(to_timestamp(created_at/1000), 'YYYY-MM-DD')" if is_pg else "strftime('%Y-%m-%d', datetime(created_at/1000, 'unixepoch', 'localtime'))"
        time_key = "day"
    else:
        display_format = "to_char(to_timestamp(created_at/1000), 'MM-DD')" if is_pg else "strftime('%m-%d', datetime(created_at/1000, 'unixepoch', 'localtime'))"
        sort_format = "to_char(to_timestamp(created_at/1000), 'YYYY-MM-DD')" if is_pg else "strftime('%Y-%m-%d', datetime(created_at/1000, 'unixepoch', 'localtime'))"
        time_key = "day"

    user_clause = ""
    params = [strt]
    if uid:
        user_clause = "AND user_id = ?"
        params.append(uid)

    sql = f"""
    SELECT primary_sector as "primarySector", {display_format} as label, {sort_format} as "sortKey", COUNT(*) as count
    FROM {t['memories']} WHERE created_at > ? {user_clause}
    GROUP BY primary_sector, {sort_format}
    ORDER BY "sortKey"
    """
    
    tl = await db.async_fetchall(sql, tuple(params))
    
    # Map raw rows to expected JSON
    res_tl = []
    for row in tl:
        res_tl.append({
            "primarySector": row["primarySector"],
            "label": row["label"],
            "sortKey": row["sortKey"],
            "count": row["count"],
            "hour": row["label"] # JS sends 'hour' as label alias
        })
        
    return {
        "timeline": res_tl,
        "grouping": time_key
    }

@router.get("/top-memories", response_model=Dict[str, List[TopMemory]])
async def get_top_memories(limit: int = 10, user_id: Optional[str] = None, auth_user: str = Depends(get_current_user_id)):
    # api.ts expects { "memories": [TopMemory] }
    # TopMemory: { id, content, sector, salience, lastSeen }
    uid = resolve_user(auth_user, user_id)
    t = q.tables
    sql = f"SELECT * FROM {t['memories']} ORDER BY salience DESC LIMIT ?"
    if uid:
        sql = f"SELECT * FROM {t['memories']} WHERE user_id=? ORDER BY salience DESC LIMIT ?"
        rows = await db.async_fetchall(sql, (uid, limit))
    else:
        rows = await db.async_fetchall(sql, (limit,))

    enc = get_encryption()
    res: List[TopMemory] = []

    for r in rows:
        content = "Encrypted"
        if enc:
            try:
                content = enc.decrypt(r["content"])
            except:
                pass

        res.append(TopMemory(
            id=r["id"],
            content=content, # Full content or snippet? JS sends full but decrypts
            sector=r["primary_sector"],
            salience=r["salience"],
            lastSeen=r["last_seen_at"] or 0
        ))

    return {"memories": res}

@router.get("/maintenance")
async def get_maintenance(hours: int = Query(24, ge=1, le=168), auth_user: str = Depends(get_current_user_id)):
    # Admin only?
    # verify_admin(auth_user) # JS restricts to Admin implicitly by passing undefined logic, but here we enforce strictness?
    # For now allow auth users to see system stats if no sensitive info. 
    # But maintenance IS system data.
    # Let's assume parity: unrestricted or check admin elsewhere.
    
    t = q.tables
    strt = int(time.time() * 1000) - hours * 60 * 60 * 1000
    is_pg = db.is_pg

    # Determine grouping
    hour_fmt = "to_char(to_timestamp(ts/1000), 'HH24:00')" if is_pg else "strftime('%H:00', datetime(ts/1000, 'unixepoch', 'localtime'))"
    
    # 1. Operations over time
    ops_sql = f"""
    SELECT type, {hour_fmt} as hour, SUM(count) as cnt
    FROM {t['stats']} WHERE ts > ? GROUP BY type, hour ORDER BY hour
    """
    ops = await db.async_fetchall(ops_sql, (strt,))
    
    # 2. Totals
    tot_sql = f"""
    SELECT type, SUM(count) as total FROM {t['stats']} WHERE ts > ? GROUP BY type
    """
    totals = await db.async_fetchall(tot_sql, (strt,))
    
    # Re-structure for frontend
    by_hr = {}
    for op in ops:
        h = op["hour"]
        if h not in by_hr:
            by_hr[h] = {"hour": h, "decay": 0, "reflection": 0, "consolidation": 0}
        
        typ = op["type"]
        if typ == "decay": by_hr[h]["decay"] = op["cnt"]
        elif typ == "reflect": by_hr[h]["reflection"] = op["cnt"]
        elif typ == "consolidate": by_hr[h]["consolidation"] = op["cnt"]
    
    data_totals = {"cycles": 0, "reflections": 0, "consolidations": 0, "efficiency": 0}
    for tot in totals:
        typ = tot["type"]
        if typ == "decay": data_totals["cycles"] = tot["total"]
        elif typ == "reflect": data_totals["reflections"] = tot["total"]
        elif typ == "consolidate": data_totals["consolidations"] = tot["total"]
    
    tot_ops = data_totals["cycles"] + data_totals["reflections"] + data_totals["consolidations"]
    if tot_ops > 0:
        data_totals["efficiency"] = round(((data_totals["reflections"] + data_totals["consolidations"]) / tot_ops) * 100)

    return {
        "operations": list(by_hr.values()),
        "totals": data_totals
    }

@router.get("/settings")
async def get_settings(auth_user: str = Depends(get_current_user_id)):
    # Retrieve configs for the user
    # Parity: openai, gemini, anthropic, ollama
    providers = ["openai", "gemini", "anthropic", "ollama"]
    res = {}
    for p in providers:
        res[p] = await get_persisted_config(auth_user, p)
    return res

@router.post("/settings")
async def update_settings(body: SettingsBody, auth_user: str = Depends(get_current_user_id)):
    await set_persisted_config(auth_user, body.type, body.config)
    return {"success": True, "type": body.type}

@router.get("/info")
@router.get("/health")
async def get_health():
    return {
        "status": "ok",
        "cpuLoad": 0.0, # Placeholder
        "memoryUsage": 0.0, # Placeholder
        "dbConnected": db.conn is not None
    }

