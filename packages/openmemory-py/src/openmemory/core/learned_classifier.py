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
        exp_scores = {s: np.exp(sc) for s, sc in scores.items()}
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
        sectors = list(set(d["label"] for d in data))
        
        weights = existing_model.get("weights", {}) if existing_model else {}
        biases = existing_model.get("biases", {}) if existing_model else {}
        
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
                exp_scores = {s: np.exp(sc) for s, sc in scores.items()}
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
