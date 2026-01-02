import asyncio
import time
import math
import json
import logging
from typing import List, Dict, Any, Optional

from ..core.db import q, db, log_maint_op
from ..core.config import env
from ..utils.vectors import cos_sim
from .hsg import add_hsg_memory

# Ported from backend/src/memory/reflect.ts

from ..core.security import get_encryption

logger = logging.getLogger("reflect")

def vec_tf(txt: str) -> List[int]:
    w = txt.lower().split()
    uniq = sorted(list(set(w)))
    return [w.count(u) for u in uniq]

def sim_txt(t1: str, t2: str) -> float:
    # Fixed robust Jaccard similarity (matches JS implementation)
    # Using simple tokenization for speed
    s1 = set(t1.lower().split())
    s2 = set(t2.lower().split())
    if not s1 or not s2: return 0.0
    
    inter = len(s1.intersection(s2))
    union = len(s1.union(s2))
    return inter / union if union > 0 else 0.0

def cluster(mems: List[Dict]) -> List[Dict]:
    cls = []
    used = set()
    
    for m in mems:
        if m["id"] in used: continue
        if m["primary_sector"] == "reflective": continue
        if m.get("meta") and "consolidated" in str(m["meta"]): continue
        
        # Helper to get plain text
        text_cache = {}
        def get_text(mem):
             if mem["id"] in text_cache: return text_cache[mem["id"]]
             try:
                 pt = get_encryption().decrypt(mem["content"])
             except:
                 pt = mem["content"]
             text_cache[mem["id"]] = pt
             return pt

        text_m = get_text(m)
        c = {"mem": [m], "n": 1}
        used.add(m["id"])
        
        for o in mems:
            if o["id"] in used: continue
            if m["primary_sector"] != o["primary_sector"]: continue
            
            if sim_txt(text_m, get_text(o)) > 0.8:
                c["mem"].append(o)
                c["n"] += 1
                used.add(o["id"])
                
        if c["n"] >= 2: cls.append(c)
        
    return cls

def calc_sal(c: Dict) -> float:
    now = time.time() * 1000
    p = c["n"] / 10.0
    
    r_sum = 0
    for m in c["mem"]:
        created = m["created_at"]
        r_sum += math.exp(-(now - created) / 43200000)
        
    r = r_sum / c["n"]
    
    # Check if any memory has 'emotional' sector in 'sectors' column (if it exists) or primary
    # TS line 66: m.sectors.includes("emotional").
    # My DB schema doesn't store 'sectors' list column directly, only primary. 
    # But `add_hsg_memory` returns `sectors`.
    # Wait, schema `memories` table DOES NOT have `sectors` column.
    # It has `primary_sector`.
    # TS `types.ts` defines `MemRow` with optional `sectors`. 
    # But `db.ts` SQLite schema doesn't have it.
    # So `m.sectors` in TS likely comes from runtime join or ignored?
    # `hsg.ts` `add_hsg_memory` returns it.
    # In `reflect.ts`, `m` comes from `q.all_mem.all`. 
    # `all_mem` select query: `select * from memories`.
    # It won't have `sectors` column.
    # So TS `m.sectors` is undefined. `includes` would throw or return false.
    # So `e` is always 0 in TS. 1:1 parity -> e=0.
    e = 0
    if c["mem"][0]["primary_sector"] == "emotional":
        e = 1.0
    else:
        for m in c["mem"]:
            meta = json.loads(m.get("meta") or "{}")
            if "emotional" in meta.get("additional_sectors", []):
                e = 0.5
                break
    
    return min(1.0, 0.6 * p + 0.3 * r + 0.1 * e)

def summ(c: Dict) -> str:
    sec = c["mem"][0]["primary_sector"]
    n = c["n"]
    # Decrypt content for summary
    enc = get_encryption()
    decoded = []
    for m in c["mem"]:
        try:
             decoded.append(enc.decrypt(m["content"]))
        except:
             decoded.append(m["content"])
             
    txt = "; ".join([t[:60] for t in decoded])
    return f"{n} {sec} pattern: {txt[:200]}"

async def mark_consolidated(ids: List[str]):
    if not ids: return
    now = int(time.time() * 1000)
    placeholders = ",".join(["?"] * len(ids))
    # We use a batch update to mark as consolidated
    sql = f"UPDATE memories SET meta = json_set(COALESCE(meta, '{{}}'), '$.consolidated', true), updated_at=? WHERE id IN ({placeholders})"
    await db.async_execute(sql, (now,) + tuple(ids))

# boost
async def boost(ids: List[str]):
    if not ids: return
    now = int(time.time() * 1000)
    placeholders = ",".join(["?"] * len(ids))
    # Batch boost salience by 10% capped at 1.0
    sql = f"UPDATE memories SET salience = MIN(1.0, COALESCE(salience, 0) * 1.1), updated_at=? WHERE id IN ({placeholders})"
    await db.async_execute(sql, (now,) + tuple(ids))

async def run_reflection() -> Dict[str, Any]:
    logger.info("[REFLECT] Starting reflection job...")
    min_mems = env.reflect_min or 20
    # Increased default scan range from 100 to 500 for better pattern detection
    limit = env.reflect_limit or 500
    mems = await q.all_mem(limit, 0)
    logger.info(f"[REFLECT] Fetched {len(mems)} memories (min {min_mems})")
    
    if len(mems) < min_mems:
        print("[REFLECT] Not enough memories, skipping")
        return {"created": 0, "reason": "low"}
        
    cls = cluster(mems)
    print(f"[REFLECT] Clustered into {len(cls)} groups")
    
    async with db.transaction(): # Use db.transaction for async context manager
        n = 0
        for c in cls:
            txt = summ(c)
            s = calc_sal(c)
            src = [m["id"] for m in c["mem"]]
            meta = {
                "type": "auto_reflect",
                "sources": src,
                "freq": c["n"],
                "at": time.strftime("%Y-%m-%dT%H:%M:%S")
            }
            
            print(f"[REFLECT] Creating reflection: {c['n']} mems, sal={s:.3f}, sec={c['mem'][0]['primary_sector']}")
            
            # Insert reflection
            # Pass commit=False to avoid nested transaction (since we are in db.transaction())
            await add_hsg_memory(txt, json.dumps(["reflect:auto"]), meta, commit=False)
            await mark_consolidated(src)
            await boost(src)
            n += 1
            
        if n > 0: 
            # Manually call q.ins_log or equivalent to bypass its commit?
            # Or just let log_maint_op commit at the very end.
            # log_maint_op in db.py has db.commit().
            # If I call it inside the transaction block, it will commit!
            # I should use db.execute directly for log_maint_op logic if I want atomicity.
            await db.async_execute("INSERT INTO stats (type, count, ts) VALUES (?, ?, ?)", ("reflect", n, int(time.time() * 1000)))
            
    print(f"[REFLECT] Job complete: created {n} reflections")
    return {"created": n, "clusters": len(cls)}

_timer_task = None

async def reflection_loop():
    interval = (env.reflect_interval or 10) * 60
    while True:
        try:
            await run_reflection()
        except Exception as e:
            print(f"[REFLECT] Error: {e}")
        await asyncio.sleep(interval)

def start_reflection():
    global _timer_task
    if not getattr(env, "auto_reflect", True) or _timer_task: return
    _timer_task = asyncio.create_task(reflection_loop())
    print(f"[REFLECT] Started: every {env.reflect_interval or 10}m")

def stop_reflection():
    global _timer_task
    if _timer_task:
        _timer_task.cancel()
        _timer_task = None
