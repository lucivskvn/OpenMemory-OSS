import asyncio
import time
import math
import json
import hashlib
from typing import List, Dict, Optional, Any, Tuple
import numpy as np
import httpx # using httpx for async http

from ..core.config import env
from ..core.models import get_model
from ..core.db import q
from ..core.constants import SECTOR_CONFIGS, SEC_WTS
from ..utils.text import canonical_tokens_from_text, synonyms_for, canonicalize_token
from ..utils.vectors import vec_to_buf, buf_to_vec

from ..ai.openai import OpenAIAdapter
from ..ai.ollama import OllamaAdapter
from ..ai.gemini import GeminiAdapter
from ..ai.aws import AwsAdapter
from ..ai.synthetic import SyntheticAdapter

async def emb_dispatch(provider: str, t: str, s: str) -> List[float]:
    try:
        if provider == "synthetic": 
            return await SyntheticAdapter(env.vec_dim or 768).embed(t, model=s)
        if provider == "openai": 
            return await OpenAIAdapter().embed(t, model=env.openai_model)
        if provider == "ollama":
            return await OllamaAdapter().embed(t, model=env.ollama_embedding_model)
        if provider == "gemini":
            return await GeminiAdapter().embed(t, model=env.gemini_embedding_model) 
        if provider == "aws":
            return await AwsAdapter().embed(t, model=env.aws_embedding_model)
    except Exception as e:
        print(f"[EMBED] Provider {provider} failed: {e}")
        raise e
        
    return await SyntheticAdapter(env.vec_dim or 768).embed(t, model=s)

# Public API

async def embed_for_sector(t: str, s: str) -> List[float]:
    if s not in SECTOR_CONFIGS: raise Exception(f"Unknown sector: {s}")
    
    # Try primary provider
    providers = [env.emb_kind] + [p for p in env.embedding_fallback if p != env.emb_kind]
    
    last_err = None
    for p in providers:
        try:
            return await emb_dispatch(p, t, s)
        except Exception as e:
            last_err = e
            continue
            
    # Ultimate fallback to synthetic if not already tried and failed
    if "synthetic" not in providers:
        try:
            return await emb_dispatch("synthetic", t, s)
        except:
            pass
            
    raise last_err or Exception(f"All embedding providers failed for sector {s}")

async def embed_multi_sector(id: str, txt: str, secs: List[str], chunks: Optional[List[dict]] = None) -> List[Dict[str, Any]]:
    # log pending
    await q.ins_log(id=id, model="multi-sector", status="pending", ts=int(time.time()*1000), err=None)
    
    try:
        # Parallelize embedding calls
        tasks = [embed_for_sector(txt, s) for s in secs]
        vectors = await asyncio.gather(*tasks)
        
        res = []
        for s, v in zip(secs, vectors):
            res.append({"sector": s, "vector": v, "dim": len(v)})
            
        await q.upd_log(id=id, status="completed", err=None)
        return res
    except Exception as e:
        await q.upd_log(id=id, status="failed", err=str(e))
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
