import asyncio
import time
import math
import json
import hashlib
import re
from typing import List, Dict, Optional, Any, Tuple
import numpy as np
import httpx

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
from ..ai.minimax import MiniMaxAdapter

async def emb_dispatch(provider: str, t: str, s: str) -> List[float]:
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
    if provider == "minimax":
        return await MiniMaxAdapter().embed(t, model=env.minimax_embedding_model)

    return await SyntheticAdapter(env.vec_dim or 768).embed(t, model=s)

async def embed_for_sector(t: str, s: str) -> List[float]:
    if s not in SECTOR_CONFIGS: raise Exception(f"Unknown sector: {s}")

    return await emb_dispatch(env.emb_kind or "synthetic", t, s)

async def embed_multi_sector(id: str, txt: str, secs: List[str], chunks: Optional[List[dict]] = None) -> List[Dict[str, Any]]:
    q.ins_log(id=id, model="multi-sector", status="pending", ts=int(time.time()*1000), err=None)

    res = []
    try:
        for s in secs:
            v = await embed_for_sector(txt, s)
            res.append({"sector": s, "vector": v, "dim": len(v)})

        q.upd_log(id=id, status="completed", err=None)
        return res
    except Exception as e:
        q.upd_log(id=id, status="failed", err=str(e))
        raise e
def calc_mean_vec(emb_res: List[Dict[str, Any]], all_sectors: List[str]) -> List[float]:
    if not emb_res:
        return []
    d = emb_res[0]["dim"]
    mean = np.zeros(d, dtype=np.float32)
    for r in emb_res:
         mean += np.array(r["vector"], dtype=np.float32)
    mean /= len(emb_res)
    return mean.tolist()

SECTOR_RELATIONSHIPS = {
    "semantic": {
        "procedural": 0.8,
        "episodic": 0.6,
        "reflective": 0.7,
        "emotional": 0.4,
    },
    "procedural": {
        "semantic": 0.8,
        "episodic": 0.6,
        "reflective": 0.6,
        "emotional": 0.3,
    },
    "episodic": {
        "reflective": 0.8,
        "semantic": 0.6,
        "procedural": 0.6,
        "emotional": 0.7,
    },
    "reflective": {
        "episodic": 0.8,
        "semantic": 0.7,
        "procedural": 0.6,
        "emotional": 0.6,
    },
    "emotional": {
        "episodic": 0.7,
        "reflective": 0.6,
        "semantic": 0.4,
        "procedural": 0.3,
    },
}

def _extract_sector_from_metadata(metadata: Optional[Dict[str, Any]]) -> Optional[str]:
    if not metadata:
        return None
    sect = metadata.get("sector")
    if not sect:
        lgm = metadata.get("lgm") or {}
        if isinstance(lgm, dict):
            sect = lgm.get("sector")
    return sect

def _score_sectors(content: str) -> Dict[str, float]:
    scores = {}
    for sector, config in SECTOR_CONFIGS.items():
        score = 0
        for pattern in config["patterns"]:
            matches = pattern.findall(content)
            if matches:
                score += len(matches) * config["weight"]
        scores[sector] = score
    return scores

def classify_content(content: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    from ..core.constants import SECTOR_CONFIGS
    sect = _extract_sector_from_metadata(metadata)

    if sect and sect in SECTOR_CONFIGS:
        return {
            "primary": sect,
            "additional": [],
            "confidence": 1.0,
        }

    scores = _score_sectors(content)

    sorted_scores = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    primary = sorted_scores[0][0]
    primary_score = sorted_scores[0][1]
    threshold = max(1.0, primary_score * 0.3)

    additional = [
        sector for sector, score in sorted_scores[1:]
        if score > 0 and score >= threshold
    ]

    confidence = 0.2
    if primary_score > 0:
        second_score = sorted_scores[1][1] if len(sorted_scores) > 1 else 0
        confidence = min(1.0, primary_score / (primary_score + second_score + 1))

    return {
        "primary": primary if primary_score > 0 else "semantic",
        "additional": additional,
        "confidence": confidence,
    }

async def embed_query_for_all_sectors(query: str, sectors: List[str]) -> Dict[str, List[float]]:
    res = {}
    for s in sectors:
        res[s] = await embed_for_sector(query, s)
    return res

def compress_vec_for_storage(vec: List[float], target_dim: int) -> List[float]:
    if len(vec) <= target_dim:
        return vec
    compressed = np.zeros(target_dim, dtype=np.float32)
    bucket_sz = len(vec) / target_dim
    for i in range(target_dim):
        start = math.floor(i * bucket_sz)
        end = math.floor((i + 1) * bucket_sz)
        sub = vec[start:end]
        if sub:
            compressed[i] = sum(sub) / len(sub)

    norm = np.linalg.norm(compressed)
    if norm > 0:
        compressed /= norm
    return compressed.tolist()

def _score_sentence(s: str, idx: int) -> float:
    sc = 0.0
    if idx == 0:
        sc += 10
    if idx == 1:
        sc += 5
    if re.match(r"^#+\s", s) or re.match(r"^[A-Z][A-Z\s]+:", s):
        sc += 8
    if re.match(r"^[A-Z][a-z]+:", s):
        sc += 6
    if re.search(r"\d{4}-\d{2}-\d{2}", s):
        sc += 7
    if re.search(r"\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d+", s, re.I):
        sc += 5
    if re.search(r"\$\d+|\d+\s*(miles|dollars|years|months|km)", s):
        sc += 4
    if re.search(r"\b[A-Z][a-z]+\s+[A-Z][a-z]+\b", s):
        sc += 3

    words = set(re.findall(r"\b[a-z]+\b", s.lower()))
    actions = {
        "bought", "purchased", "serviced", "visited", "went", "got", "received", "paid",
        "earned", "learned", "discovered", "found", "saw", "met", "completed", "finished",
        "fixed", "implemented", "created", "updated", "added", "removed", "resolved"
    }
    if words.intersection(actions):
        sc += 4

    questions = {"who", "what", "when", "where", "why", "how"}
    if words.intersection(questions):
        sc += 2

    if len(s) < 80:
        sc += 2

    if words.intersection({"i", "my", "me"}):
        sc += 1

    return sc

def extract_essence(raw: str, sec: str, max_len: int) -> str:
    from ..core.config import env
    if not env.use_summary_only or len(raw) <= max_len:
        return raw

    sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+", raw) if s.strip()]
    sents = [s for s in sents if len(s) > 10]
    if not sents:
        return raw[:max_len]

    scored = [{"text": s, "score": _score_sentence(s, idx), "idx": idx} for idx, s in enumerate(sents)]
    scored.sort(key=lambda x: x["score"], reverse=True)

    selected = []
    current_len = 0

    first_sent = next((s for s in scored if s["idx"] == 0), None)
    if first_sent and len(first_sent["text"]) < max_len:
        selected.append(first_sent)
        current_len += len(first_sent["text"])

    for item in scored:
        if item["idx"] == 0:
            continue
        if current_len + len(item["text"]) + 2 <= max_len:
            selected.append(item)
            current_len += len(item["text"]) + 2

    if not selected and scored:
        return raw[:max_len]

    selected.sort(key=lambda x: x["idx"])
    return " ".join([s["text"] for s in selected])
