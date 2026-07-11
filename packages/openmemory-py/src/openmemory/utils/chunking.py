import math
import re
from typing import List, Dict, TypedDict, Optional
try:
    import tiktoken
    _HAS_TIKTOKEN = True
except ImportError:
    _HAS_TIKTOKEN = False

class Chunk(TypedDict):
    text: str
    start: int
    end: int
    tokens: int

def get_tokenizer():
    if _HAS_TIKTOKEN:
        try:
            return tiktoken.get_encoding("cl100k_base")
        except (ValueError, RuntimeError):
            return None
    return None

_tokenizer = get_tokenizer()

def est_tokens(t: str) -> int:
    if _tokenizer:
        # Use disallowed_special=() to treat special tokens as normal text
        return len(_tokenizer.encode(t, disallowed_special=()))
    # Fallback to character-based estimate if tiktoken is not available
    return math.ceil(len(t) / 4)

def chunk_text(txt: str, tgt: int = 768, ovr: float = 0.1) -> List[Chunk]:
    tot = est_tokens(txt)
    if tot <= tgt:
        return [{"text": txt, "start": 0, "end": len(txt), "tokens": tot}]

    tch = tgt * 4
    och = math.floor(tch * ovr)
    paras = re.split(r"\n\n+", txt)

    chks: List[Chunk] = []
    cur = ""
    cs = 0
    cur_tokens = 0

    for p in paras:
        sents = re.split(r"(?<=[.!?])\s+", p)
        for s in sents:
            s_tokens = est_tokens(s)
            pot_tokens = cur_tokens + (1 if cur else 0) + s_tokens

            if pot_tokens > tgt and len(cur) > 0:
                chks.append({
                    "text": cur,
                    "start": cs,
                    "end": cs + len(cur),
                    "tokens": cur_tokens
                })
                ovt = cur[-och:] if och < len(cur) else cur
                ovt_tokens = est_tokens(ovt)
                cur = ovt + " " + s
                cs = cs + len(cur) - len(ovt) - 1
                cur_tokens = ovt_tokens + 1 + s_tokens
            else:
                cur = cur + (" " if cur else "") + s
                cur_tokens = pot_tokens

    if len(cur) > 0:
        chks.append({
            "text": cur,
            "start": cs,
            "end": cs + len(cur),
            "tokens": cur_tokens
        })
    return chks

def agg_vec(vecs: List[List[float]]) -> List[float]:
    n = len(vecs)
    if not n: raise ValueError("no vecs")
    if n == 1: return vecs[0].copy()

    d = len(vecs[0])
    r = [0.0] * d
    for v in vecs:
        for i in range(d):
            r[i] += v[i]

    rc = 1.0 / n
    for i in range(d):
        r[i] *= rc
    return r

def join_chunks(cks: List[Chunk]) -> str:
    return " ".join(c["text"] for c in cks) if cks else ""
