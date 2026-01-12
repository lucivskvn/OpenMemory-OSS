import asyncio
import time
import math
import json
import hashlib
import logging
from typing import List, Dict, Optional, Any, Tuple
import numpy as np
import httpx # using httpx for async http

from ..core.config import env
from ..core.models import get_model
from ..core.db import q
from ..core.constants import SECTOR_CONFIGS, SEC_WTS
from ..utils.text import canonical_tokens_from_text, synonyms_for, canonicalize_token
from ..utils.vectors import vec_to_buf, buf_to_vec

from ..ai.adapters import get_adapter

logger = logging.getLogger(__name__)

async def emb_dispatch(provider: str, t: str, s: str, user_id: Optional[str] = None) -> List[float]:
    try:
        adapter = await get_adapter(user_id)
        if provider == "synthetic": 
            return await adapter.embed(t, model=s)
        if provider == "openai": 
            return await adapter.embed(t, model=env.openai_model or "text-embedding-3-small")
        if provider == "ollama":
            return await adapter.embed(t, model=env.ollama_embedding_model or "nomic-embed-text")
        if provider == "gemini":
            return await adapter.embed(t, model=env.gemini_embedding_model or "models/text-embedding-004") 
        if provider == "aws":
            return await adapter.embed(t, model=env.aws_embedding_model or "amazon.titan-embed-text-v1")
    except Exception as e:
        logger.warning(f"[EMBED] Provider {provider} failed: {e}")
        # If the user-specific adapter failed, we might want to fallback to system? 
        # But get_adapter already handles that if no user config.
        raise e
        
    # Final fallback if provider didn't match or returned None (unlikely with Synthetic fallback in AdapterFactory)
    return await (await get_adapter(None)).embed(t, model=s)

# Public API

async def embed_for_sector(t: str, s: str, user_id: Optional[str] = None) -> List[float]:
    if s not in SECTOR_CONFIGS: raise ValueError(f"Unknown sector: {s}")
    
    # Try primary provider
    providers = [env.emb_kind] + [p for p in env.embedding_fallback if p != env.emb_kind]
    
    last_err = None
    for p in providers:
        try:
            return await emb_dispatch(p, t, s, user_id)
        except Exception as e:
            last_err = e
            continue
            
    # Ultimate fallback to synthetic if not already tried and failed
    if "synthetic" not in providers:
        try:
            return await emb_dispatch("synthetic", t, s, user_id)
        except Exception:
            pass
            
    raise last_err or Exception(f"All embedding providers failed for sector {s}")

async def embed_multi_sector(id: str, txt: str, secs: List[str], chunks: Optional[List[dict]] = None, user_id: Optional[str] = None, commit: bool = True) -> List[Dict[str, Any]]:
    # log pending
    await q.ins_log(id=id, model="multi-sector", status="pending", ts=int(time.time()*1000), err=None, user_id=user_id, commit=commit)
    
    try:
        # Parallelize embedding calls
        tasks = [embed_for_sector(txt, s, user_id) for s in secs]
        vectors = await asyncio.gather(*tasks)
        
        res = []
        for s, v in zip(secs, vectors):
            res.append({"sector": s, "vector": v, "dim": len(v)})
            
        await q.upd_log(id=id, status="completed", err=None, user_id=user_id, commit=commit)
        return res
    except Exception as e:
        await q.upd_log(id=id, status="failed", err=str(e), user_id=user_id, commit=commit)
        raise e

async def embed_batch_multi_sector(items: List[Dict[str, Any]], user_id: Optional[str] = None, commit: bool = True) -> List[List[Dict[str, Any]]]:
    """
    Efficiently embed multiple items across multiple sectors.
    items: List of {'id', 'content', 'sectors'}
    """
    if not items: return []
    
    # 1. Log all as pending
    ts = int(time.time()*1000)
    for item in items:
        await q.ins_log(id=item["id"], model="multi-sector-batch", status="pending", ts=ts, err=None, user_id=user_id, commit=commit)
    
    try:
        # 2. Group by sector to use adapter.embed_batch
        sector_map: Dict[str, List[Dict[str, Any]]] = {}
        for idx, item in enumerate(items):
            for s in item["sectors"]:
                if s not in sector_map: sector_map[s] = []
                sector_map[s].append({"idx": idx, "content": item["content"]})
        
        # 3. For each sector, call embed_batch
        # We could parallelize sectors too
        results: List[List[Dict[str, Any]]] = [[] for _ in range(len(items))]
        
        async def proc_sector(s, workload):
            if not workload: return
            texts = [w["content"] for w in workload]
            # Try primary provider with fallback (simplified reuse of embed_for_sector logic)
            providers = [env.emb_kind] + [p for p in env.embedding_fallback if p != env.emb_kind]
            
            vecs = None
            for p in providers:
                try:
                    adapter = await get_adapter(user_id)
                    vecs = await adapter.embed_batch(texts, model=s)
                    break
                except Exception:
                    continue
            
            if vecs is None:
                # Synthetic fallback
                adapter = await get_adapter(None) # Force system/synthetic if others fail
                vecs = await adapter.embed_batch(texts, model=s)
                
            for w, v in zip(workload, vecs):
                results[w["idx"]].append({"sector": s, "vector": v, "dim": len(v)})

        await asyncio.gather(*(proc_sector(s, wl) for s, wl in sector_map.items()))
        
        # 4. Update logs
        for item in items:
            await q.upd_log(id=item["id"], status="completed", err=None, user_id=user_id, commit=commit)
            
        return results
    except Exception as e:
        for item in items:
            await q.upd_log(id=item["id"], status="failed", err=str(e), user_id=user_id, commit=commit)
        raise e

# Agg helpers
def calc_mean_vec(emb_res: List[Dict[str, Any]], all_sectors: List[str]) -> List[float]:
    if not emb_res: return []
    dim = emb_res[0]["dim"]
    # beta=2.0 from HYBRID_PARAMS
    beta = 2.0
    epsilon = 1e-8
    
    # Calculate weights based on sector importance (softmax-like)
    exp_sum = 0
    weighted_vectors = []
    
    for r in emb_res:
        sec_wt = SECTOR_CONFIGS.get(r["sector"], {}).get("weight", 1.0)
        ew = math.exp(beta * sec_wt)
        exp_sum += ew
        weighted_vectors.append((r["vector"], ew))
        
    wsum = np.zeros(dim, dtype=np.float32)
    for vec, ew in weighted_vectors:
        sm_wt = ew / exp_sum
        wsum += np.array(vec, dtype=np.float32) * sm_wt
        
    norm = np.linalg.norm(wsum) + epsilon
    return (wsum / norm).tolist()
