import math
from typing import List, Dict, Any, Optional
import numpy as np
from .adapter import AIAdapter
from ..utils.text import canonical_tokens_from_text, synonyms_for, canonicalize_token
from ..core.constants import SEC_WTS

class SyntheticAdapter(AIAdapter):
    def __init__(self, dim: int = 1536):
        self.dim = dim

    async def chat(
        self, messages: List[Dict[str, str]], model: Optional[str] = None, **kwargs
    ) -> str:
        return "Synthetic response."

    async def chat_json(
        self, prompt: str, schema: Optional[Dict[str, Any]] = None, **kwargs
    ) -> Dict[str, Any]:
        return {}

    async def embed(self, text: str, model: Optional[str] = None) -> List[float]:
        return self._gen_syn_emb(text, model or "semantic")

    async def embed_batch(
        self, texts: List[str], model: Optional[str] = None
    ) -> List[List[float]]:
        return [self._gen_syn_emb(t, model or "semantic") for t in texts]

    def _fnv1a(self, v: str) -> int:
        h = 0x811c9dc5
        for c in v:
            h = (h ^ ord(c)) * 16777619
            h &= 0xffffffff
        return h

    def _murmurish(self, v: str, seed: int) -> int:
        h = seed
        for c in v:
            h = (h ^ ord(c)) * 0x5bd1e995
            h &= 0xffffffff
            h = (h >> 13) ^ h
            h &= 0xffffffff
        return h

    def _add_feat(self, vec: np.ndarray, k: str, w: float):
        h = self._fnv1a(k)
        h2 = self._murmurish(k, 0xdeadbeef)
        val = w * (1.0 - float((h & 1) << 1))

        if (self.dim & (self.dim - 1)) == 0:
            vec[h & (self.dim - 1)] += val
            vec[h2 & (self.dim - 1)] += val * 0.5
        else:
            vec[h % self.dim] += val
            vec[h2 % self.dim] += val * 0.5

    def _add_pos_feat(self, vec: np.ndarray, pos: int, w: float):
        idx = pos % self.dim
        ang = pos / pow(10000, (2 * idx) / self.dim)
        vec[idx] += w * math.sin(ang)
        vec[(idx + 1) % self.dim] += w * math.cos(ang)

    def _gen_syn_emb(self, t: str, s: str) -> List[float]:
        d = self.dim
        v = np.zeros(d, dtype=np.float32)
        ct = canonical_tokens_from_text(t)

        if not ct:
            x = 1.0 / math.sqrt(d)
            return [x] * d

        et = []
        for tok in ct:
            et.append(tok)
            syns = synonyms_for(tok)
            if syns:
                for syn in syns: et.append(canonicalize_token(syn))

        el = len(et)
        tc = {}
        for tok in et: tc[tok] = tc.get(tok, 0) + 1

        sw = SEC_WTS.get(s, 1.0)
        dl = math.log(1 + el)

        # Unigrams & Char n-grams
        for tok, c in tc.items():
            tf = c / el
            idf = math.log(1 + el/c)
            w = (tf * idf + 1) * sw
            self._add_feat(v, f"{s}|tok|{tok}", w)
            if len(tok) >= 3:
                for i in range(len(tok) - 2):
                    self._add_feat(v, f"{s}|c3|{tok[i:i+3]}", w * 0.4)
            if len(tok) >= 4:
                for i in range(len(tok) - 3):
                    self._add_feat(v, f"{s}|c4|{tok[i:i+4]}", w * 0.3)

        # Bigrams
        for i in range(len(ct) - 1):
            a, b = ct[i], ct[i+1]
            if a and b:
                pw = 1.0 / (1.0 + i * 0.1)
                self._add_feat(v, f"{s}|bi|{a}_{b}", 1.4 * sw * pw)

        # Trigrams
        for i in range(len(ct) - 2):
            a, b, c = ct[i], ct[i+1], ct[i+2]
            if a and b and c:
                self._add_feat(v, f"{s}|tri|{a}_{b}_{c}", 1.0 * sw)

        # Skip bigrams
        for i in range(min(len(ct) - 2, 20)):
            a, c = ct[i], ct[i+2]
            if a and c:
                self._add_feat(v, f"{s}|skip|{a}_{c}", 0.7 * sw)

        # Positional Features
        for i in range(min(len(ct), 50)):
            self._add_pos_feat(v, i, (0.5 * sw) / dl)

        # Length Bucket
        lb = min(math.floor(math.log2(el + 1)), 10)
        self._add_feat(v, f"{s}|len|{lb}", 0.6 * sw)

        # Density Bucket
        dens = len(tc) / el if el > 0 else 0
        db = math.floor(dens * 10)
        self._add_feat(v, f"{s}|dens|{db}", 0.5 * sw)

        n = np.linalg.norm(v)
        if n > 0: v /= n
        return v.tolist()
