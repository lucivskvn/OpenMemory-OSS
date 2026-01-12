import asyncio
import time
import math
import random
import json
import logging
from typing import List, Dict, Any, Optional
from ..core.db import q, db, transaction
from ..core.config import env
from ..core.vector_store import vector_store as store
from ..utils.vectors import buf_to_vec, vec_to_buf, cos_sim
from ..utils.text import canonical_tokens_from_text
from ..ops.dynamics import COGNITIVE_PARAMS

# Ported from backend/src/memory/decay.ts

logger = logging.getLogger("openmemory.memory.decay")

class DecayCfg:
    def __init__(self):
        self.threads = int(env.decay_threads or 3)
        self.cold_threshold = float(env.decay_cold_threshold or 0.25)
        self.reinforce_on_query = True # default true
        self.regeneration_enabled = True # default true
        self.max_vec_dim = int(env.max_vector_dim or 1536)
        self.min_vec_dim = int(env.min_vector_dim or 64)
        self.summary_layers = min(3, max(1, int(env.summary_layers or 3)))
        self.lambda_hot = 0.005
        self.lambda_warm = 0.02
        self.lambda_cold = 0.05
        self.time_unit_ms = 86_400_000

cfg = DecayCfg()

active_q = 0
last_decay = 0
COOLDOWN = 60000

def inc_q():
    global active_q
    active_q += 1

def dec_q():
    global active_q
    active_q = max(0, active_q - 1)

def pick_tier(m: Dict, now_ts: int) -> str:
    dt = max(0, now_ts - (m.get("last_seen_at") or m.get("updated_at") or now_ts))
    recent = dt < 6 * 86_400_000
    high = (m.get("coactivations") or 0) > 5 or (m.get("salience") or 0) > 0.7
    if recent and high: return "hot"
    if recent or (m.get("salience") or 0) > 0.4: return "warm"
    return "cold"

def calc_decay(sec: str, init_sal: float, days_since: float, m_tier: Optional[str] = None) -> float:
    """Standardized decay formula used for both live scoring and background maintenance."""
    from ..core.constants import SECTOR_CONFIGS
    from ..ops.dynamics import HYBRID_PARAMS
    sec_cfg = SECTOR_CONFIGS.get(sec, {"decay_lambda": 0.02})
    
    # Base lambda
    lam = sec_cfg.get("decay_lambda", 0.02)
    
    # Dynamic adjust if tier is provided
    if m_tier == "hot": lam *= 0.5
    elif m_tier == "cold": lam *= 1.5
    
    # Salience-weighted decay factor (higher salience decays slower)
    # f = exp(-lam * (dt / (sal + 0.1)))
    f = math.exp(-lam * (days_since / (init_sal + 0.1)))
    decayed = init_sal * f
    
    # Reinforcement floor from HYBRID_PARAMS (Sustainability/Consistency)
    reinf_alpha = HYBRID_PARAMS.get("alpha_reinforce", 0.1)
    reinf = reinf_alpha * (1 - math.exp(-lam * days_since))
    
    return max(0.0, min(1.0, decayed + reinf))

def mean(arr: List[float]) -> float:
    return sum(arr) / len(arr) if arr else 0

def normalize(v: List[float]):
    n = math.sqrt(sum(x*x for x in v))
    if n > 0:
        for i in range(len(v)): v[i] /= n

def compress_vector(vec: List[float], f: float, min_dim=64, max_dim=1536) -> List[float]:
    src = vec if vec else [1.0]
    tgt_dim = max(min_dim, min(max_dim, math.floor(len(src) * max(0.0, min(1.0, f)))))
    dim = max(min_dim, min(len(src), tgt_dim))
    
    if dim >= len(src): return list(src)
    
    pooled = []
    bucket = math.ceil(len(src) / dim)
    for i in range(0, len(src), bucket):
        sub = src[i : i+bucket]
        pooled.append(mean(sub))
    
    normalize(pooled)
    return pooled

def hash_to_vec(s: str, d=32) -> List[float]:
    h = 2166136261
    for c in s:
        h ^= ord(c)
        h = (h * 16777619) & 0xffffffff
        
    out = [0.0] * max(2, d)
    x = h or 1
    for i in range(len(out)):
        x ^= (x << 13) & 0xffffffff
        x ^= (x >> 17) & 0xffffffff
        x ^= (x << 5) & 0xffffffff
        out[i] = ((x / 0xffffffff) * 2 - 1)
        
    normalize(out)
    return out

def top_keywords(t: str, k=5) -> List[str]:
    # simple version
    words = canonical_tokens_from_text(t)
    freq = {}
    for w in words: freq[w] = freq.get(w, 0) + 1
    items = sorted(freq.items(), key=lambda x: x[1], reverse=True)
    return [x[0] for x in items[:k]]

def fingerprint_mem(m: Dict) -> Dict[str, Any]:
    base = f"{m['id']}|{m.get('generated_summary') or m['content'] or ''}".strip()
    vec = hash_to_vec(base, 32)
    summary = " ".join(top_keywords(m.get('generated_summary') or m['content'] or "", 3))
    return {"vector": vec, "summary": summary}

def calc_recency_score(last_seen: int) -> float:
    now = int(time.time() * 1000)
    dt = max(0, now - last_seen)
    # Base decay using lambda_cold as baseline
    hours = dt / 3600000.0
    return math.exp(-0.05 * hours) # approximate decay logic

    
async def apply_decay():
    global last_decay
    if active_q > 0:
        logger.debug(f"[decay] skipped - {active_q} active queries")
        return
        
    now_ts = int(time.time() * 1000)
    if now_ts - last_decay < COOLDOWN:
        rem = (COOLDOWN - (now_ts - last_decay)) / 1000
        logger.debug(f"[decay] skipped - cooldown active ({rem:.0f}s left)")
        return
        
    last_decay = now_ts
    t0 = time.time()
    
    # get segments
    t = q.tables
    segments_rows = await db.async_fetchall(f"SELECT DISTINCT segment FROM {t['memories']} ORDER BY segment DESC")
    segments = [r["segment"] for r in segments_rows]
    
    tot_proc = 0
    tot_chg = 0
    tot_comp = 0
    tot_fp = 0
    tier_counts = {"hot": 0, "warm": 0, "cold": 0}
    
    for seg in segments:
        async with transaction():
            t = q.tables
            # We fetch more fields to support the different logic paths
            rows = await db.async_fetchall(f"SELECT id,content,generated_summary as summary,salience,decay_lambda,last_seen_at,updated_at,primary_sector,feedback_score as coactivations FROM {t['memories']} WHERE segment=?", (seg,))
            
            decay_ratio = env.decay_ratio or 0.03
            batch_sz = max(1, int(len(rows) * decay_ratio))
            if not rows: continue
            
            start_idx = random.randint(0, max(0, len(rows) - batch_sz))
            batch = rows[start_idx : start_idx + batch_sz]
            
            # Batch update list
            salience_updates = []
            
            for m in batch:
                dict_m = dict(m)
                m_tier = pick_tier(dict_m, now_ts)
                tier_counts[m_tier] += 1
                
                # Standardize Lambda: Prefer Memory's own decay_lambda if set, then Sector config, then Tier defaults
                sec = dict_m.get("primary_sector") or "semantic"
                from ..core.constants import SECTOR_CONFIGS
                sec_cfg = SECTOR_CONFIGS.get(sec, {"decay_lambda": 0.02})
                
                lam = dict_m.get("decay_lambda") or sec_cfg.get("decay_lambda") or \
                      (cfg.lambda_hot if m_tier == "hot" else (cfg.lambda_warm if m_tier == "warm" else cfg.lambda_cold))
                
                dt = max(0, (now_ts - (dict_m["last_seen_at"] or dict_m["updated_at"] or 0)) / cfg.time_unit_ms)
                act = max(0, dict_m.get("coactivations") or dict_m.get("feedback_score") or 0)
                
                # Consistency with hsg.py's calc_decay (but keeping f-factor for tiered logic)
                sal = max(0.0, min(1.0, (dict_m["salience"] or 0.5) * (1 + math.log1p(act))))
                f = math.exp(-lam * (dt / (sal + 0.1)))
                new_sal = max(0.0, min(1.0, sal * f))
                
                changed = abs(new_sal - (dict_m["salience"] or 0)) > 0.001
                
                # Compression / Cold storage logic
                if f < 0.7:
                    sector = dict_m["primary_sector"] or "semantic"
                    vec_row = await store.getVector(dict_m["id"], sector)
                    if not vec_row:
                        vec_row = await store.getVector(dict_m["id"], sector + "_cold")
                    
                    if vec_row and vec_row.vector:
                        vec = vec_row.vector
                        if len(vec) > cfg.min_vec_dim:
                             new_vec = compress_vector(vec, f, cfg.min_vec_dim, cfg.max_vec_dim)
                             if len(new_vec) < len(vec):
                                 target_sector = sector + "_cold"
                                 await store.storeVector(dict_m["id"], target_sector, new_vec, len(new_vec))
                                 if target_sector != sector:
                                     await store.deleteVectors(dict_m["id"], sector)
                                 tot_comp += 1
                                 changed = True
                                 
                if f < max(0.3, cfg.cold_threshold):
                    sector = dict_m["primary_sector"] or "semantic"
                    fp = fingerprint_mem(dict_m)
                    target_sector = sector + "_cold"
                    await store.storeVector(dict_m["id"], target_sector, fp["vector"], len(fp["vector"]))
                    if target_sector != sector:
                        await store.deleteVectors(dict_m["id"], sector)
                    
                    await db.async_execute(f"UPDATE {t['memories']} SET generated_summary=? WHERE id=?", (fp["summary"], dict_m["id"]))
                    tot_fp += 1
                    changed = True

                if changed:
                    salience_updates.append((new_sal, now_ts, dict_m["id"]))
                    tot_chg += 1
                
                tot_proc += 1
            
            # Batch execute salience updates
            if salience_updates:
                await db.async_executemany(f"UPDATE {t['memories']} SET salience=?, updated_at=? WHERE id=?", salience_updates)
            
            # Yield once per segment instead of once per memory
            await asyncio.sleep(0.05)
    dur = (time.time() - t0) * 1000
    if tot_proc > 0:
        logger.info(f"[decay] {tot_chg}/{tot_proc} | tiers: {tier_counts} | comp={tot_comp} fp={tot_fp} | {dur:.1f}ms")

async def on_query_hit(mem_id: str, sector: str, reembed_fn = None, user_id: Optional[str] = None):
    # reembed_fn: async (text) -> list[float]
    if not cfg.regeneration_enabled and not cfg.reinforce_on_query: return
    
    m = await q.get_mem(mem_id, user_id=user_id)
    if not m: return
    
    updated = False
    
    # Regeneration (if vector degraded/compressed but accessed again)
    if cfg.regeneration_enabled and reembed_fn:
        # Check main sector
        vec_row = await store.getVector(mem_id, sector, user_id=user_id)
        if not vec_row:
             # Check cold sector
             vec_row = await store.getVector(mem_id, sector + "_cold", user_id=user_id)
             
        if vec_row and vec_row.vector and len(vec_row.vector) <= 64:
             # it was compressed/cold, regenerate full
             try:
                 base = m["generated_summary"] or m["content"] or ""
                 new_vec = await reembed_fn(base)
                 # Restore to MAIN sector
                 await store.storeVector(mem_id, sector, new_vec, len(new_vec))
                 # Clean up cold vector
                 await store.deleteVectors(mem_id, sector + "_cold")
                 updated = True
             except Exception as e:
                 logger.warning(f"[decay] regeneration failed: {e}")
                 pass

    # Reinforcement
    if cfg.reinforce_on_query:
        new_sal = min(1.0, (m["salience"] or 0.5) + COGNITIVE_PARAMS["QUERY_HIT_BOOST"])
        
        t = q.tables
        await db.async_execute(f"UPDATE {t['memories']} SET salience=?, last_seen_at=? WHERE id=? AND (user_id=? OR user_id IS NULL)", (new_sal, int(time.time()*1000), mem_id, user_id))
        await db.async_commit()
        updated = True
        
    if updated:
        # print(f"[decay] reinforced {mem_id}")
        pass

# --- Loop Control ---

_decay_task = None

async def decay_loop():
    interval = (env.decay_interval or 5) * 60 # default 5 minutes
    # logger already defined at module level
    while True:
        try:
            await apply_decay()
        except Exception as e:
            logger.error(f"[decay] Loop error: {e}")
        await asyncio.sleep(interval)

def start_decay():
    global _decay_task
    if _decay_task: return
    _decay_task = asyncio.create_task(decay_loop())
    logger.info(f"[decay] Started: every {(env.decay_interval or 5)}m")

def stop_decay():
    global _decay_task
    if _decay_task:
        _decay_task.cancel()
        _decay_task = None
