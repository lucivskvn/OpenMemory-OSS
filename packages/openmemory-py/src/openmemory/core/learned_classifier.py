import numpy as np
import json
import time
import logging
from typing import List, Dict, Any, Optional, Tuple

logger = logging.getLogger("classifier")

class LearnedClassifier:
    """
    A simple Linear Classifier for sector classification.
    Parity with openmemory-js implementation.
    """
    
    _cache: Dict[str, Dict[str, Any]] = {}
    _cache_ttl: int = 60000 # 60s
    _max_cache: int = 100

    @classmethod
    async def load(cls, user_id: str) -> Optional[Dict[str, Any]]:
        """
        Load classifier model for user, checking memory cache first.
        """
        now = int(time.time() * 1000)
        
        # Check cache
        if user_id in cls._cache:
            entry = cls._cache[user_id]
            if now - entry["ts"] < cls._cache_ttl:
                return entry["model"]
            else:
                del cls._cache[user_id]

        from .db import q
        
        # Fetch from DB
        row = await q.get_classifier_model(user_id)
        if not row: return None

        try:
            model = {
                "userId": user_id,
                "weights": json.loads(row["weights"]),
                "biases": json.loads(row["biases"]),
                "version": row["version"],
                "updatedAt": row["updated_at"]
            }
            
            # Update cache
            if len(cls._cache) >= cls._max_cache:
                # Simple removal of random key or oldest? 
                # Python dicts preserve insertion order, pop first item
                cls._cache.pop(next(iter(cls._cache)))
            
            cls._cache[user_id] = {"model": model, "ts": now}
            return model
        except Exception as e:
            logger.error(f"[Classifier] Failed to load model for {user_id}: {e}")
            return None

    @staticmethod
    def predict(vector: List[float], model: Dict[str, Any]) -> Dict[str, Any]:
        """
        Predict sector class for a given embedding vector.
        """
        weights = model.get("weights", {})
        biases = model.get("biases", {})
        
        scores = {}
        vec = np.array(vector)
        
        for sector, w_list in weights.items():
            w = np.array(w_list)
            bias = biases.get(sector, 0.0)
            
            # Simple dot product
            # Handle dimension mismatch if vector lengths differ
            min_len = min(len(vec), len(w))
            score = np.dot(vec[:min_len], w[:min_len]) + bias
            scores[sector] = score

        if not scores:
            return {"primary": "semantic", "additional": [], "confidence": 0.0}

        # Softmax-like normalization for confidence
        max_sc = max(scores.values()) if scores else 0
        exp_scores = {s: np.exp(sc - max_sc) for s, sc in scores.items()}
        sum_exp = sum(exp_scores.values())
        
        normalized = [
            {"sector": s, "prob": prob / (sum_exp if sum_exp > 0 else 1.0)}
            for s, prob in exp_scores.items()
        ]
        normalized.sort(key=lambda x: x["prob"], reverse=True)
        
        primary = normalized[0]
        additional = [x["sector"] for x in normalized[1:3] if x["prob"] > 0.2]
        
        return {
            "primary": primary["sector"],
            "additional": additional,
            "confidence": float(primary["prob"])
        }

    @staticmethod
    def train(
        data: List[Dict[str, Any]],
        existing_model: Optional[Dict[str, Any]] = None,
        lr: float = 0.01,
        epochs: int = 10
    ) -> Dict[str, Any]:
        """
        Train the classifier using SGD.
        """
        if not data:
            return existing_model or {"weights": {}, "biases": {}, "version": 1, "updated_at": 0}

        dim = len(data[0]["vector"]) if data else 1536
        # Consolidate sectors from data and existing model
        sectors_set = set(d["label"] for d in data)
        weights = (existing_model or {}).get("weights", {})
        biases = (existing_model or {}).get("biases", {})
        
        for s in weights: sectors_set.add(s)
        sectors = list(sectors_set)
        
        # Initialize new sectors
        for sector in sectors:
            if sector not in weights:
                # Small random initialization
                weights[sector] = ((np.random.rand(dim) - 0.5) * 0.01).tolist()
                biases[sector] = 0.0

        # Convert to numpy for training
        w_np = {s: np.array(weights[s]) for s in weights}
        b_np = {s: biases[s] for s in biases}
        
        for epoch in range(epochs):
            for sample in data:
                vec = np.array(sample["vector"])
                label = sample["label"]
                
                # Target: 1 for label, 0 for others
                targets = {s: (1.0 if s == label else 0.0) for s in sectors}
                
                # Forward pass
                scores = {s: np.dot(vec, w_np[s]) + b_np[s] for s in sectors}
                max_sc = max(scores.values()) if scores else 0
                exp_scores = {s: np.exp(sc - max_sc) for s, sc in scores.items()}
                sum_exp = sum(exp_scores.values())
                probs = {s: exp_scores[s] / (sum_exp if sum_exp > 0 else 1.0) for s in sectors}
                
                # Backward pass (Gradient Descent)
                for s in sectors:
                    error = probs[s] - targets[s]
                    # Gradient w.r.t weights and bias
                    w_np[s] -= lr * error * vec
                    b_np[s] -= lr * error

        return {
            "weights": {s: w.tolist() for s, w in w_np.items()},
            "biases": b_np,
            "version": (existing_model.get("version", 0) if existing_model else 0) + 1,
            "updated_at": int(time.time() * 1000)
        }
