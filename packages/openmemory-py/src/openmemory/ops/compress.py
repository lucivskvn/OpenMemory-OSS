import re
import time
import hashlib
import math
import logging
from typing import Dict, Any, List, Optional

logger = logging.getLogger("openmemory.ops.compress")

# Port of backend/src/ops/compress.ts

class MemoryCompressionEngine:
    """
    Engine for various text compression strategies to optimize memory storage and token usage.
    Implementation includes semantic, syntactic, and aggressive algorithms.
    """
    def __init__(self):
        """Initialize the compression engine with stats and an LRU cache."""
        self.stats = {
            "total": 0,
            "ogTok": 0,
            "compTok": 0,
            "saved": 0,
            "avgRatio": 0,
            "savings_latency": 0,
            "algos": {},
            "updated": int(time.time() * 1000)
        }
        self.cache = {}
        self.MAX = 500
        self.MS = 0.05
        
    def tok(self, t: str) -> int:
        """
        Estimate token count for a piece of text.
        
        Args:
            t: The text to estimate.
            
        Returns:
            Approximate token count.
        """
        if not t: return 0
        w = len([x for x in re.split(r"\s+", t.strip()) if x])
        c = len(t)
        # Improved heuristic: characters/4.2 + words/1.5 for technical text
        return max(1, math.ceil(c / 4.2 + w / 1.5))
        
    def sem(self, t: str) -> str:
        """
        Perform semantic compression by removing fillers, duplicates, and redundant phrases.
        Preserves sentence-ending punctuation.
        
        Args:
            t: The text to compress.
            
        Returns:
            Semantically compressed text.
        """
        if not t or len(t) < 50: return t
        c = t
        
        # Split into sentences keeping punctuation via lookbehind
        s = [x.strip() for x in re.split(r"(?<=[.!?])\s+", c) if x.strip()]
        
        # Unique consecutive sentences filter
        u = []
        for i, x in enumerate(s):
            if i == 0:
                u.append(x)
                continue
            if x.lower() != s[i-1].lower(): u.append(x)
            
        c = " ".join(u).strip()
        
        # Filler removal
        fillers = [
            r"\b(just|really|very|quite|rather|somewhat|somehow)\b",
            r"\b(actually|basically|essentially|literally)\b",
            r"\b(I think that|I believe that|It seems that|It appears that)\b",
            r"\b(in order to)\b"
        ]
        for p in fillers:
            c = re.sub(p, "", c, flags=re.IGNORECASE)
            
        c = re.sub(r"\s+", " ", c).strip()
        
        replacements = [
            (r"\bat this point in time\b", "now"),
            (r"\bdue to the fact that\b", "because"),
            (r"\bin the event that\b", "if"),
            (r"\bfor the purpose of\b", "to"),
            (r"\bin the near future\b", "soon"),
            (r"\ba number of\b", "several"),
            (r"\bprior to\b", "before"),
            (r"\bsubsequent to\b", "after")
        ]
        for p, x in replacements:
            c = re.sub(p, x, c, flags=re.IGNORECASE)
            
        return c

    def syn(self, t: str) -> str:
        """
        Perform syntactic compression using contractions and whitespace normalization.
        
        Args:
            t: The text to compress.
            
        Returns:
            Syntactically compressed text.
        """
        if not t or len(t) < 30: return t
        c = t
        ct = [
            (r"\bdo not\b", "don't"),
            (r"\bcannot\b", "can't"),
            (r"\bwill not\b", "won't"),
            (r"\bshould not\b", "shouldn't"),
            (r"\bwould not\b", "wouldn't"),
            (r"\bit is\b", "it's"),
            (r"\bthat is\b", "that's"),
            (r"\bwhat is\b", "what's"),
            (r"\bwho is\b", "who's"),
            (r"\bthere is\b", "there's"),
            (r"\bhas been\b", "been"),
            (r"\bhave been\b", "been")
        ]
        for p, x in ct:
            c = re.sub(p, x, c, flags=re.IGNORECASE)
            
        c = re.sub(r"\b(the|a|an)\s+(\w+),\s+(the|a|an)\s+", r"\2, ", c, flags=re.IGNORECASE)
        c = re.sub(r"\s*{\s*", "{", c)
        c = re.sub(r"\s*}\s*", "}", c)
        c = re.sub(r"\s*\(\s*", "(", c)
        c = re.sub(r"\s*\)\s*", ")", c)
        c = re.sub(r"\s*;\s*", ";", c)
        return c

    def agg(self, t: str) -> str:
        """
        Perform aggressive compression including Markdown removal, URL domain Extraction, 
        and industry-standard abbreviations.
        
        Args:
            t: The text to compress.
            
        Returns:
            Aggressively compressed text.
        """
        if not t: return t
        c = self.sem(t)
        c = self.syn(c)
        c = re.sub(r"[*_~`#]", "", c)
        c = re.sub(r"https?://(www\.)?([^\/\s]+)(/[^\s]*)?", r"\2", c, flags=re.IGNORECASE)
        
        abbr = [
            (r"\bJavaScript\b", "JS"),
            (r"\bTypeScript\b", "TS"),
            (r"\bPython\b", "Py"),
            (r"\bapplication\b", "app"),
            (r"\bfunction\b", "fn"),
            (r"\bparameter\b", "param"),
            (r"\bargument\b", "arg"),
            (r"\breturn\b", "ret"),
            (r"\bvariable\b", "var"),
            (r"\bconstant\b", "const"),
            (r"\bdatabase\b", "db"),
            (r"\brepository\b", "repo"),
            (r"\benvironment\b", "env"),
            (r"\bconfiguration\b", "config"),
            (r"\bdocumentation\b", "docs")
        ]
        for p, x in abbr:
             c = re.sub(p, x, c, flags=re.IGNORECASE)
             
        c = re.sub(r"\n{3,}", "\n\n", c)
        c = "\n".join([l.strip() for l in c.split("\n")])
        return c.strip()

    def compress(self, t: str, a: str = "semantic") -> Dict[str, Any]:
        """
        Execute compression strategy on input text.
        
        Args:
            t: Input text.
            a: Algorithm name ('semantic', 'syntactic', 'aggressive').
            
        Returns:
            Dict containing original text, compressed text, metrics, and hash.
        """
        if not t:
            return {
                "og": t, "comp": t, 
                "metrics": self.empty(a),
                "hash": self.hash(t)
            }
            
        k = f"{a}:{self.hash(t)}"
        if k in self.cache: 
            return self.cache[k]
        
        ot = self.tok(t)
        if a == "semantic": c = self.sem(t)
        elif a == "syntactic": c = self.syn(t)
        elif a == "aggressive": c = self.agg(t)
        else: c = t
        
        ct = self.tok(c)
        sv = ot - ct
        r = ct / ot if ot > 0 else 1
        p = (sv / ot) * 100 if ot > 0 else 0
        l = sv * self.MS
        
        m = {
            "ogTok": ot, "compTok": ct, "ratio": r, "saved": sv, 
            "pct": p, "latency": l, "algo": a, "ts": int(time.time()*1000)
        }
        res = {
            "og": t, "comp": c, "metrics": m, "hash": self.hash(t)
        }
        self.up(m)
        self.store(k, res)
        return res
        
    def batch(self, ts: List[str], a: str = "semantic") -> List[Dict[str, Any]]:
        """Process multiple strings in batch."""
        return [self.compress(t, a) for t in ts]
        
    def auto(self, t: str) -> Dict[str, Any]:
        """
        Automatically select the best compression algorithm based on text content features.
        
        Args:
            t: The text to analyze and compress.
            
        Returns:
            Dict result of the selected compression algorithm.
        """
        if not t or len(t) < 50: return self.compress(t, "semantic")
        # Detect if text looks like code, has URLs, or is verbose
        code = bool(re.search(r"\b(function|const|let|var|def|class|import|export|fn|func|namespace|include|pub|trait|impl)\b", t)) or \
               bool(re.search(r"[{}:;](?:\s*[\w$]+\s*[:=]\s*|\s*[\w$]+\s*\()", t))
        urls = bool(re.search(r"https?://", t))
        verb = len(t.split()) > 100
        
        if code or urls: a = "aggressive"
        elif verb: a = "semantic"
        else: a = "syntactic"
        return self.compress(t, a)
        
    def empty(self, a: str) -> Dict[str, Any]:
        """Return empty metrics template."""
        return {
            "ogTok": 0, "compTok": 0, "ratio": 1, "saved": 0, 
            "pct": 0, "latency": 0, "algo": a, "ts": int(time.time()*1000)
        }
        
    def hash(self, t: str) -> str:
        """Generate a short stable hash for text caching."""
        return hashlib.md5(t.encode("utf-8")).hexdigest()[:16]
        
    def up(self, m: Dict[str, Any]):
        """Update instance statistics with new metrics."""
        self.stats["total"] += 1
        self.stats["ogTok"] += m["ogTok"]
        self.stats["compTok"] += m["compTok"]
        self.stats["saved"] += m["saved"]
        self.stats["savings_latency"] += m["latency"]
        if self.stats["ogTok"] > 0:
            self.stats["avgRatio"] = self.stats["compTok"] / self.stats["ogTok"]
        
        algo = m["algo"]
        self.stats["algos"][algo] = self.stats["algos"].get(algo, 0) + 1
        self.stats["updated"] = int(time.time()*1000)
        
    def store(self, k: str, r: Dict[str, Any]):
        """Store result in LRU cache with eviction logic."""
        if len(self.cache) >= self.MAX:
            first = next(iter(self.cache))
            del self.cache[first]
            logger.debug(f"Evicted item from compression cache: {first}")
        self.cache[k] = r

    def get_stats(self) -> Dict[str, Any]:
        """Access engine statistics."""
        return self.stats

        
compression_engine = MemoryCompressionEngine()
