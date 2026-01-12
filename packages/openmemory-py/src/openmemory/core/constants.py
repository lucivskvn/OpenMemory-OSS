from typing import Dict, List, TypedDict, Pattern
import re
from .config import env

# Ported from backend/src/memory/hsg.ts to avoid circular dep

class SectorCfg(TypedDict):
    model: str
    decay_lambda: float
    weight: float
    patterns: List[Pattern]

SECTOR_CONFIGS: Dict[str, SectorCfg] = {
    "episodic": {
        "model": "episodic-optimized",
        "decay_lambda": env.decay_episodic,
        "weight": 1.2,
        "patterns": [
            re.compile(r"\b(today|yesterday|tomorrow|last\s+(week|month|year)|next\s+(week|month|year))\b", re.I),
            re.compile(r"\b(remember\s+when|recall|that\s+time|when\s+I|I\s+was|we\s+were)\b", re.I),
            re.compile(r"\b(went|saw|met|felt|heard|visited|attended|participated)\b", re.I),
            re.compile(r"\b(at\s+\d{1,2}:\d{2}|on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b", re.I),
            re.compile(r"\b(event|moment|experience|incident|occurrence|happened)\b", re.I),
            re.compile(r"\bI\s+'?m\s+going\s+to\b", re.I),
        ],
    },
    "semantic": {
        "model": "semantic-optimized",
        "decay_lambda": env.decay_semantic,
        "weight": 1.0,
        "patterns": [
            re.compile(r"\b(is\s+a|represents|means|stands\s+for|defined\s+as)\b", re.I),
            re.compile(r"\b(concept|theory|principle|law|hypothesis|theorem|axiom)\b", re.I),
            re.compile(r"\b(fact|statistic|data|evidence|proof|research|study|report)\b", re.I),
            re.compile(r"\b(capital|population|distance|weight|height|width|depth)\b", re.I),
            re.compile(r"\b(history|science|geography|math|physics|biology|chemistry)\b", re.I),
            re.compile(r"\b(know|understand|learn|read|write|speak)\b", re.I),
        ],
    },
    "procedural": {
        "model": "procedural-optimized",
        "decay_lambda": env.decay_procedural,
        "weight": 1.1,
        "patterns": [
            re.compile(r"\b(how\s+to|step\s+by\s+step|guide|tutorial|manual|instructions)\b", re.I),
            re.compile(r"\b(first|second|then|next|finally|afterwards|lastly)\b", re.I),
            re.compile(r"\b(install|run|execute|compile|build|deploy|configure|setup)\b", re.I),
            re.compile(r"\b(click|press|type|enter|select|drag|drop|scroll)\b", re.I),
            re.compile(r"\b(method|function|class|algorithm|routine|recipe)\b", re.I),
            re.compile(r"\b(to\s+do|to\s+make|to\s+build|to\s+create)\b", re.I),
        ],
    },
    "emotional": {
        "model": "emotional-optimized",
        "decay_lambda": env.decay_emotional,
        "weight": 0.9,
        "patterns": [
            re.compile(r"\b(feel|feeling|felt|emotions?|mood|vibe)\b", re.I),
            re.compile(r"\b(happy|sad|angry|mad|excited|scared|anxious|nervous|depressed)\b", re.I),
            re.compile(r"\b(love|hate|like|dislike|adore|detest|enjoy|loathe)\b", re.I),
            re.compile(r"\b(amazing|terrible|awesome|awful|wonderful|horrible|great|bad)\b", re.I),
            re.compile(r"\b(frustrated|confused|overwhelmed|stressed|relaxed|calm)\b", re.I),
            re.compile(r"\b(wow|omg|yay|nooo|ugh|sigh)\b", re.I),
            re.compile(r"[!]{2,}", re.I),
        ],
    },
    "reflective": {
        "model": "reflective-optimized",
        "decay_lambda": env.decay_reflective,
        "weight": 1.3,
        "patterns": [
            re.compile(r"\b(realize|realized|realization|insight|epiphany)\b", re.I),
            re.compile(r"\b(think|thought|thinking|ponder|contemplate|reflect)\b", re.I),
            re.compile(r"\b(understand|understood|understanding|grasp|comprehend)\b", re.I),
            re.compile(r"\b(pattern|trend|connection|link|relationship|correlation)\b", re.I),
            re.compile(r"\b(lesson|moral|takeaway|conclusion|summary|implication)\b", re.I),
            re.compile(r"\b(feedback|review|analysis|evaluation|assessment)\b", re.I),
            re.compile(r"\b(improve|grow|change|adapt|evolve)\b", re.I),
        ],
    },
}

SEC_WTS = {k: v["weight"] for k, v in SECTOR_CONFIGS.items()}

COGNITIVE_PARAMS = {
    "EMA_ALPHA": 0.1,  # Factor for feedback_score (score * 0.1 + old * 0.9)
    "REINFORCE_DECAY_LAMBDA": 0.02, # For context propagation
    "QUERY_HIT_BOOST": 0.5, # Salience boost on successful retrieval
    "DEDUPLICATION_BOOST": 0.15, # Salience boost for existing memory
    "HAMMING_THRESHOLD": 3, # Distance for simhash deduplication
    "WAYPOINT_DECAY": 0.8, # BFS expansion decay
    "EXPAN_MIN_WEIGHT": 0.1, # Min weight to continue expansion
    "DEFAULT_SALIENCE": 0.0,
    "DEFAULT_DECAY_LAMBDA": 0.02,
    "DEFAULT_VERSION": 1,
    "DEFAULT_SEGMENT": 0,
    "DEFAULT_LAST_SEEN_AT": 0,
}
