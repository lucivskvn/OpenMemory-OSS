from fastapi import APIRouter, Depends, HTTPException
from typing import List, Optional, Dict, Any
from ...core.db import db, q
from ...core.security import get_encryption
from ...core.config import env
from ...core.types import SystemStats
from ..metrics import metrics
from ..dependencies import get_current_user_id, resolve_user
import time
import sys

router = APIRouter()

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

@router.get("/activity")
async def get_activity(limit: int = 50, user_id: Optional[str] = None, auth_user: str = Depends(get_current_user_id)):
    # api.ts expects { "activities": [ActivityItem] }
    # ActivityItem: { id, type, sector, content, salience, timestamp }
    uid = resolve_user(auth_user, user_id)
    mems = await q.all_mem(limit=limit, user_id=uid)
    res = []
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
        act_type = "memory_created" if m["version"] <= 1 else "memory_updated"

        res.append({
            "id": m["id"],
            "type": act_type,
            "sector": m["primary_sector"],
            "content": content[:100], # Snippet
            "salience": m["salience"],
            "timestamp": m["updated_at"] or m["created_at"]
        })

    return {"activities": res}

@router.get("/top-memories")
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
    res = []

    for r in rows:
        content = "Encrypted"
        if enc:
            try:
                content = enc.decrypt(r["content"])
            except:
                pass

        res.append({
            "id": r["id"],
            "content": content[:200],
            "sector": r["primary_sector"],
            "salience": r["salience"],
            "lastSeen": r["last_seen_at"]
        })

    return {"memories": res}

@router.get("/info")
@router.get("/health")
async def get_health():
    return {
        "status": "ok",
        "cpuLoad": 0.0, # Placeholder
        "memoryUsage": 0.0, # Placeholder
        "dbConnected": db.conn is not None
    }
