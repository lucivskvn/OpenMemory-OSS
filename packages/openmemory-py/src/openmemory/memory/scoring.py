import time
import math
from typing import Dict, List, Any

# V2 Scoring Logic
# Components:
# - Relevance (Cosine Sim): 0-1
# - Recency (Exponential Decay): 0-1
# - Importance (Salience): 0-1+
# - Frequency (Access count): 0-1?

def calculate_score(
    relevance: float, 
    created_at: int, 
    last_seen_at: int,
    salience: float,
    decay_lambda: float = 0.02, # default half life logic
    debug: bool = False
) -> Dict[str, Any] | float:
    
    now = int(time.time() * 1000)
    
    # Recency
    # hours since last access?
    # Original backend used hours.
    hours_ago = max(0, (now - last_seen_at) / (1000 * 3600))
    # Decay function: e^(-lambda * t)
    recency = math.exp(-decay_lambda * hours_ago)
    
    # Combined
    # Score = (Relevance * alpha) + (Recency * beta) + (Salience * gamma)?
    # Or multiplicative?
    # Backend v1 was: (sim * 0.7) + (recency * 0.3) * salience?
    # Let's standardize on a V2 formula:
    
    from ..ops.dynamics import SCORING_WEIGHTS

    # Use standardized weights
    w_sim = SCORING_WEIGHTS.get("similarity", 0.35)
    w_rec = SCORING_WEIGHTS.get("recency", 0.10)
    w_imp = SCORING_WEIGHTS.get("salience_boost", 0.2) # fallback/approx
    
    # Normalize weights sum approx to 1.0 for score
    # Formula: sim * w_sim + rec * w_rec + sal * w_imp
    # Note: SCORING_WEIGHTS has overlap/waypoint/tag_match which are not inputs here.
    # We rescale for the inputs we have (relevance/recency/salience).
    
    total_w = w_sim + w_rec + w_imp
    
    final = (relevance * w_sim + recency * w_rec + min(salience, 1.0) * w_imp) / total_w
    
    if debug:
        return {
            "score": final,
            "components": {
                "relevance": relevance,
                "recency": recency,
                "salience": salience,
                "age_hours": hours_ago,
                "weights": {"sim": w_sim, "rec": w_rec, "imp": w_imp}
            }
        }
    return final
