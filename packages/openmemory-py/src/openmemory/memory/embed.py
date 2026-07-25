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

def _get_preset_sector(metadata: Optional[Dict[str, Any]]) -> Optional[str]:
    if not metadata:
        return None
    sect = metadata.get("sector")
    if not sect and isinstance(metadata.get("lgm"), dict):
        sect = metadata["lgm"].get("sector")
    if sect in SECTOR_CONFIGS:
        return sect
    return None

def classify_content(content: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    sect = _get_preset_sector(metadata)
    if sect:
        return {
            "primary": sect,
            "additional": [],
            "confidence": 1.0
        }

    scores = {}
    for sector, config in SECTOR_CONFIGS.items():
        score = 0
        for pattern in config["patterns"]:
            matches = pattern.findall(content)
            if matches:
                score += len(matches) * config["weight"]
        scores[sector] = score

    sorted_scores = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    primary = sorted_scores[0][0]
    primary_score = sorted_scores[0][1]

    threshold = max(1.0, primary_score * 0.3)
    additional = [s for s, sc in sorted_scores[1:] if sc > 0 and sc >= threshold]

    confidence = (
        min(1.0, primary_score / (primary_score + sorted_scores[1][1] + 1.0))
        if primary_score > 0
        else 0.2
    )

    return {
        "primary": primary if primary_score > 0 else "semantic",
        "additional": additional,
        "confidence": confidence
    }

async def embed_query_for_all_sectors(query: str, sectors: List[str]) -> Dict[str, List[float]]:
    res = {}
    for s in sectors:
        res[s] = await embed_for_sector(query, s)
    return res

def compress_vec_for_storage(vec: List[float], target_dim: int) -> List[float]:
    if len(vec) <= target_dim: return vec
    compressed = np.zeros(target_dim, dtype=np.float32)
    bucket_sz = len(vec) / target_dim
    for i in range(target_dim):
        start = math.floor(i * bucket_sz)
        end = math.floor((i + 1) * bucket_sz)
        sub = vec[start:end]
        compressed[i] = sum(sub) / len(sub) if sub else 0.0
    norm = np.linalg.norm(compressed)
    if norm > 0:
        compressed /= norm
    return compressed.tolist()

def extract_essence(raw: str, sec: str, max_len: int) -> str:
    # Fail-fast if we should bypass summarization
    if not env.use_summary_only or len(raw) <= max_len:
        return raw

    # Tokenize input text into clean sentences
    sentence_list = [sent.strip() for sent in re.split(r"(?<=[.!?])\s+", raw) if len(sent.strip()) > 10]
    if not sentence_list:
        return raw[:max_len]

    def _get_sentence_score(sentence: str, position: int) -> float:
        points = 0.0
        if position == 0:
            points += 10
        elif position == 1:
            points += 5

        # Heuristic rules for scoring sentences
        if re.match(r"^#+\s", sentence) or re.match(r"^[A-Z][A-Z\s]+:", sentence):
            points += 8
        if re.match(r"^[A-Z][a-z]+:", sentence):
            points += 6
        if re.search(r"\d{4}-\d{2}-\d{2}", sentence):
            points += 7
        if re.search(r"\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d+", sentence, re.I):
            points += 5
        if re.search(r"\$\d+|\d+\s*(miles|dollars|years|months|km)", sentence):
            points += 4
        if re.search(r"\b[A-Z][a-z]+\s[A-Z][a-z]+", sentence):
            points += 3

        words_in_sentence = set(canonical_tokens_from_text(sentence.lower()))
        # Canonicalize action keywords to match stemmed tokens
        actions_list = {
            canonicalize_token("bought"), canonicalize_token("purchased"), canonicalize_token("serviced"),
            canonicalize_token("visited"), canonicalize_token("went"), canonicalize_token("got"),
            canonicalize_token("received"), canonicalize_token("paid"), canonicalize_token("earned"),
            canonicalize_token("learned"), canonicalize_token("discovered"), canonicalize_token("found"),
            canonicalize_token("saw"), canonicalize_token("met"), canonicalize_token("completed"),
            canonicalize_token("finished"), canonicalize_token("fixed"), canonicalize_token("implemented"),
            canonicalize_token("created"), canonicalize_token("updated"), canonicalize_token("added"),
            canonicalize_token("removed"), canonicalize_token("resolved")
        }
        if words_in_sentence.intersection(actions_list):
            points += 4

        # Canonicalize question keywords to match stemmed tokens
        questions_list = {
            canonicalize_token("who"), canonicalize_token("what"), canonicalize_token("when"),
            canonicalize_token("where"), canonicalize_token("why"), canonicalize_token("how")
        }
        if words_in_sentence.intersection(questions_list):
            points += 2

        if len(sentence) < 80:
            points += 2
        if any(pronoun in sentence for pronoun in ("I", "my", "me")):
            points += 1

        return points

    # Build scored sentences list and sort by point value
    scored_items = []
    for idx, text in enumerate(sentence_list):
        scored_items.append((text, _get_sentence_score(text, idx), idx))

    scored_items.sort(key=lambda x: x[1], reverse=True)

    budget_left = max_len
    reconstructed_segments = []

    # Try to pin the very first sentence if it fits
    head_sent = next((item for item in scored_items if item[2] == 0), None)
    if head_sent and len(head_sent[0]) < budget_left:
        reconstructed_segments.append(head_sent)
        budget_left -= len(head_sent[0])

    for text, points, original_pos in scored_items:
        if original_pos == 0:
            continue
        # Check if this sentence can be appended within length budget (accounting for space separator)
        cost = len(text) + (2 if reconstructed_segments else 0)
        if cost <= budget_left:
            reconstructed_segments.append((text, points, original_pos))
            budget_left -= cost

    # Sort chosen sentences back to their original sequence
    reconstructed_segments.sort(key=lambda x: x[2])
    # Fallback to raw truncation if no sentences were selected
    if not reconstructed_segments:
        return raw[:max_len]
    return " ".join([item[0] for item in reconstructed_segments])
