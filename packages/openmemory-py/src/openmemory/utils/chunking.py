import math
import re
import numpy as np
from typing import List, Dict, TypedDict

# Ported from backend/src/utils/chunking.ts

class Chunk(TypedDict):
    text: str
    start: int
    end: int
    tokens: int

CPT = 4
def est(t: str) -> int:
    """Estimate token count based on character length."""
    return math.ceil(len(t) / CPT)

def chunk_text(txt: str, tgt: int = 768, ovr: float = 0.1) -> List[Chunk]:
    """
    Split text into overlapping chunks of approximately tgt tokens.
    Uses paragraph and sentence boundaries to avoid mid-sentence cuts.
    
    Args:
        txt: The source text.
        tgt: Target token count per chunk.
        ovr: Overlap percentage (0.0 to 1.0).
        
    Returns:
        List of Chunk dicts with original offsets.
    """
    tot = est(txt)
    if tot <= tgt:
        return [{"text": txt, "start": 0, "end": len(txt), "tokens": tot}]
    
    tch = tgt * CPT
    och = math.floor(tch * ovr)
    
    # Identify all sentences and their true offsets
    all_sents = []
    # Split by paragraphs first
    for p_match in re.finditer(r"[^\n]+(?:\n[^\n]+)*", txt):
        p_str = p_match.group()
        p_offset = p_match.start()
        # Find sentences within paragraph
        for s_match in re.finditer(r"([^.!?]+)([.!?]+\s*|$)", p_str):
            s_text = s_match.group()
            if s_text.strip():
                all_sents.append({
                    "text": s_text,
                    "start": p_offset + s_match.start(),
                    "end": p_offset + s_match.end(),
                    "tokens": est(s_text)
                })
                
    if not all_sents:
         return [{"text": txt, "start": 0, "end": len(txt), "tokens": tot}]

    chks: List[Chunk] = []
    cur_sents = []
    cur_tokens = 0
    
    for s in all_sents:
        if cur_tokens + s["tokens"] > tgt and cur_sents:
            # Commit current chunk
            start = cur_sents[0]["start"]
            end = cur_sents[-1]["end"]
            chks.append({
                "text": txt[start:end],
                "start": start,
                "end": end,
                "tokens": cur_tokens
            })
            
            # Keep some sentences for overlap
            overlap_sents = []
            overlap_chars = 0
            for os in reversed(cur_sents):
                if overlap_chars >= och: break
                overlap_sents.insert(0, os)
                overlap_chars += len(os["text"])
            
            cur_sents = overlap_sents + [s]
            cur_tokens = sum(x["tokens"] for x in cur_sents)
        else:
            cur_sents.append(s)
            cur_tokens += s["tokens"]
            
    if cur_sents:
        start = cur_sents[0]["start"]
        end = cur_sents[-1]["end"]
        chks.append({
            "text": txt[start:end],
            "start": start,
            "end": end,
            "tokens": cur_tokens
        })
        
    return chks

def agg_vec(vecs: List[List[float]]) -> List[float]:
    """Perform mean-pooling on a list of vectors."""
    if not vecs: raise ValueError("no vecs")
    if len(vecs) == 1: return vecs[0].copy()
    
    arr = np.array(vecs, dtype=np.float32)
    return np.mean(arr, axis=0).tolist()

def join_chunks(cks: List[Chunk]) -> str:
    """Utility to join chunk texts with spaces."""
    return " ".join(c["text"] for c in cks) if cks else ""
