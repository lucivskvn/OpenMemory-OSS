import math
import asyncio
from typing import List, Dict, Any, Optional

from ..core.db import q, db
from ..core.constants import SECTOR_CONFIGS

# Port from backend/src/ops/dynamics.ts
# Only porting unused functions if needed, but focusing on core ones used by HSG.

# Cognitive Dynamics Constants
# Shared between hsg.py, decay.py and maintenance functions

SCORING_WEIGHTS = {
    "similarity": 0.35,
    "overlap": 0.20,
    "waypoint": 0.15,
    "recency": 0.10,
    "tag_match": 0.20,
}

HYBRID_PARAMS = {
    "tau": 3.0,
    "beta": 2.0,
    "eta": 0.1,
    "gamma": 0.2,
    "alpha_reinforce": 0.08,
    "t_days": 7.0,
    "t_max_days": 60.0,
    "tau_hours": 1.0,
    "epsilon": 1e-8,
}

REINFORCEMENT = {
    "salience_boost": 0.1,
    "waypoint_boost": 0.05,
    "max_salience": 1.0,
    "max_waypoint_weight": 1.0,
    "prune_threshold": 0.05,
}

SECTOR_RELATIONSHIPS = {
    "episodic": {"reflective": 0.8, "semantic": 0.6, "procedural": 0.6, "emotional": 0.7},
    "semantic": {"procedural": 0.8, "episodic": 0.6, "reflective": 0.7, "emotional": 0.4},
    "procedural": {"semantic": 0.8, "episodic": 0.6, "reflective": 0.6, "emotional": 0.3},
    "emotional": {"episodic": 0.7, "reflective": 0.6, "semantic": 0.4, "procedural": 0.3},
    "reflective": {"episodic": 0.8, "semantic": 0.7, "procedural": 0.6, "emotional": 0.6},
}

# Legacy Constants (v1 parity)
ALPHA_LEARNING_RATE_FOR_RECALL_REINFORCEMENT = HYBRID_PARAMS["alpha_reinforce"]
BETA_LEARNING_RATE_FOR_EMOTIONAL_FREQUENCY = 0.2
GAMMA_ATTENUATION_CONSTANT_FOR_GRAPH_DISTANCE = HYBRID_PARAMS["gamma"]
THETA_CONSOLIDATION_COEFFICIENT_FOR_LONG_TERM = 0.4
ETA_REINFORCEMENT_FACTOR_FOR_TRACE_LEARNING = 0.18
LAMBDA_ONE_FAST_DECAY_RATE = 0.015
LAMBDA_TWO_SLOW_DECAY_RATE = 0.002
TAU_ENERGY_THRESHOLD_FOR_RETRIEVAL = 0.4

SECTORAL_INTERDEPENDENCE_MATRIX_FOR_COGNITIVE_RESONANCE = [
    [1.0, 0.7, 0.3, 0.6, 0.6], # 0
    [0.7, 1.0, 0.4, 0.7, 0.8], # 1
    [0.3, 0.4, 1.0, 0.5, 0.2], # 2
    [0.6, 0.7, 0.5, 1.0, 0.8], # 3
    [0.6, 0.8, 0.2, 0.8, 1.0], # 4
]

SECTOR_INDEX_MAPPING_FOR_MATRIX_LOOKUP = {
    "episodic": 0,
    "semantic": 1,
    "procedural": 2,
    "emotional": 3,
    "reflective": 4,
}

async def calculateCrossSectorResonanceScore(ms: str, qs: str, bs: float) -> float:
    si = SECTOR_INDEX_MAPPING_FOR_MATRIX_LOOKUP.get(ms, 1)
    ti = SECTOR_INDEX_MAPPING_FOR_MATRIX_LOOKUP.get(qs, 1)
    return bs * SECTORAL_INTERDEPENDENCE_MATRIX_FOR_COGNITIVE_RESONANCE[si][ti]

async def applyRetrievalTraceReinforcementToMemory(mid: str, sal: float) -> float:
    # sal + ETA * (1 - sal)
    return min(1.0, sal + ETA_REINFORCEMENT_FACTOR_FOR_TRACE_LEARNING * (1.0 - sal))

async def propagateAssociativeReinforcementToLinkedNodes(sid: str, ssal: float, wps: List[Dict], user_id: Optional[str] = None) -> List[Dict]:
    # wps: [{target_id, weight}]
    if not wps: return []
    
    ups = []
    tids = [wp["target_id"] for wp in wps]
    
    # Bulk fetch current saliences
    placeholders = ",".join(["?"] * len(tids))
    sql = f"SELECT id, salience FROM memories WHERE id IN ({placeholders})"
    params = tids
    if user_id:
        sql += " AND user_id=?"
        params.append(user_id)
        
    rows = await db.async_fetchall(sql, tuple(params))
    sal_map = {r["id"]: r["salience"] for r in rows}
    
    for wp in wps:
        tid = wp["target_id"]
        wt = wp["weight"]
        curr = sal_map.get(tid)
        if curr is not None:
             pr = ETA_REINFORCEMENT_FACTOR_FOR_TRACE_LEARNING * wt * ssal
             new_sal = min(1.0, curr + pr)
             ups.append({"node_id": tid, "new_salience": new_sal, "current_salience": curr})
             
    return ups
