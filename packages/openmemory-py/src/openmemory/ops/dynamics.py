import math
import asyncio
from typing import List, Dict, Any, Optional

from ..core.db import q, db
from ..core.constants import SECTOR_CONFIGS, COGNITIVE_PARAMS

from ..core.config import env

import logging
logger = logging.getLogger("openmemory.ops.dynamics")

# Port from backend/src/ops/dynamics.ts

SCORING_WEIGHTS = {
    "similarity": env.scoring_similarity,
    "overlap": env.scoring_overlap,
    "waypoint": env.scoring_waypoint,
    "recency": env.scoring_recency,
    "tag_match": env.scoring_tag_match,
}

HYBRID_PARAMS = {
    "tau": 3.0,
    "beta": 2.0,
    "eta": 0.1,
    "gamma": 0.2,
    "alpha_reinforce": env.reinf_salience_boost,
    "t_days": 7.0,
    "t_max_days": 60.0,
    "tau_hours": 1.0,
    "epsilon": 1e-8,
}

REINFORCEMENT = {
    "salience_boost": env.reinf_salience_boost,
    "waypoint_boost": env.reinf_waypoint_boost,
    "max_salience": env.reinf_max_salience,
    "max_waypoint_weight": env.reinf_max_waypoint_weight,
    "prune_threshold": env.reinf_prune_threshold,
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
    """
    Calculate resonance between two sectors based on cognitive interdependence.
    
    Args:
        ms: Memory sector.
        qs: Query sector.
        bs: Base score.
    """
    si = SECTOR_INDEX_MAPPING_FOR_MATRIX_LOOKUP.get(ms, 1)
    ti = SECTOR_INDEX_MAPPING_FOR_MATRIX_LOOKUP.get(qs, 1)
    return bs * SECTORAL_INTERDEPENDENCE_MATRIX_FOR_COGNITIVE_RESONANCE[si][ti]

async def applyRetrievalTraceReinforcementToMemory(mid: str, sal: float) -> float:
    """
    Calculate new salience for a memory after a successful retrieval (trace learning).
    """
    # sal + ETA * (1 - sal)
    return min(1.0, sal + ETA_REINFORCEMENT_FACTOR_FOR_TRACE_LEARNING * (1.0 - sal))

async def propagateAssociativeReinforcementToLinkedNodes(sid: str, ssal: float, wps: List[Dict], user_id: Optional[str] = None) -> List[Dict]:
    """
    Calculate salience updates for nodes connected to a reinforced source node.
    
    Args:
        sid: Source memory ID.
        ssal: Source salience after reinforcement.
        wps: List of waypoints [{target_id, weight}].
        user_id: Owner user ID for isolation.
    """
    # wps: [{target_id, weight}]
    if not wps: return []
    
    ups = []
    tids = [wp["target_id"] for wp in wps]
    
    # Bulk fetch current saliences
    placeholders = ",".join(["?"] * len(tids))
    t = q.tables
    sql = f"SELECT id, salience FROM {t['memories']} WHERE id IN ({placeholders})"
    params = list(tids) # Ensure mutable list
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
async def perform_spreading_activation_retrieval(init_ids: List[str], max_iterations: int, user_id: Optional[str] = None) -> Dict[str, float]:
    """
    Performs iterative spreading activation retrieval across the associative waypoint graph.
    Simulates cognitive priming by activating neighbors of query candidates.
    """
    activation = {mid: 1.0 for mid in init_ids}
    MAX_ACTIVATED_NODES = 2000
    traversal_budget = 10000

    for i in range(max_iterations):
        # Filter and sort by energy
        current_batch = sorted(
            [(mid, en) for mid, en in activation.items() if en >= 0.05],
            key=lambda x: x[1], 
            reverse=True
        )
        if not current_batch: break

        # Safety cap: top 500 energy sources
        processing_batch = current_batch[:500]
        batch_ids = [cid for cid, _ in processing_batch]

        if traversal_budget <= 0:
            logger.warning("[Dynamics] Spreading activation halted: Traversal budget exceeded.")
            break

        all_neighbors = []
        CHUNK_SIZE = 500
        for j in range(0, len(batch_ids), CHUNK_SIZE):
            if traversal_budget <= 0: break
            chunk = batch_ids[j:j + CHUNK_SIZE]
            chunk_neighbors = await q.get_waypoints_by_srcs(chunk, user_id)
            all_neighbors.extend(chunk_neighbors)
            traversal_budget -= len(chunk_neighbors)

        # Group by src_id
        neighbor_map = {}
        for n in all_neighbors:
            src = n["src_id"]
            if src not in neighbor_map: neighbor_map[src] = []
            neighbor_map[src].append({"dst_id": n["dst_id"], "weight": n["weight"]})

        updates = {}
        attenuation = math.exp(-GAMMA_ATTENUATION_CONSTANT_FOR_GRAPH_DISTANCE * (i + 1))

        for node_id, current_energy in processing_batch:
            neighbors = neighbor_map.get(node_id, [])
            for nb in neighbors:
                propagated = nb["weight"] * current_energy * attenuation
                updates[nb["dst_id"]] = updates.get(nb["dst_id"], 0.0) + propagated

        changed = False
        for target_id, new_act in updates.items():
            current = activation.get(target_id, 0.0)
            if new_act > current:
                activation[target_id] = new_act
                changed = True

        if not changed: break

        # Capping
        if len(activation) > MAX_ACTIVATED_NODES:
            sorted_nodes = sorted(activation.items(), key=lambda x: x[1], reverse=True)
            activation = dict(sorted_nodes[:MAX_ACTIVATED_NODES])

    return activation

def sigmoid(x: float) -> float:
    if math.isnan(x): return 0.5
    if x < -40: return 0.0
    if x > 40: return 1.0
    return 1.0 / (1.0 + math.exp(-x))

def calculate_recency_score(last_seen_at: int, tau: float = 0.5, max_days: int = 60) -> float:
    ms_now = int(time.time() * 1000)
    days_since = (ms_now - last_seen_at) / 86400000.0
    return max(0.0, math.exp(-days_since / tau) * (1.0 - days_since / max_days))
