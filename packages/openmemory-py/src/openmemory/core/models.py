import yaml
import os
import logging
from pathlib import Path
from typing import Dict, Any, Optional

logger = logging.getLogger("openmemory.models")

ModelCfg = Dict[str, Dict[str, str]]

_cfg: Optional[ModelCfg] = None

def get_defaults() -> ModelCfg:
    return {
        "episodic": { "openai": "text-embedding-3-small", "local": "all-MiniLM-L6-v2" },
        "semantic": { "openai": "text-embedding-3-small", "local": "all-MiniLM-L6-v2" },
        "procedural": { "openai": "text-embedding-3-small", "local": "all-MiniLM-L6-v2" },
        "emotional": { "openai": "text-embedding-3-small", "local": "all-MiniLM-L6-v2" },
        "reflective": { "openai": "text-embedding-3-large", "local": "all-mpnet-base-v2" }
    }

def load_models() -> ModelCfg:
    global _cfg
    if _cfg: return _cfg
    
    # Try multiple paths for models.yml
    # 1. ROOT/.env (legacy location mentioned in comments)
    # 2. ROOT/models.yml
    # 3. Current Working Directory
    root = Path(__file__).parent.parent.parent.parent
    paths = [
        root / "models.yml",
        Path.cwd() / "models.yml"
    ]
    
    config_path = None
    for p in paths:
        if p.exists():
            config_path = p
            break
            
    if not config_path:
        logger.info("models.yml not found, using defaults")
        return get_defaults()
        
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            _cfg = yaml.safe_load(f)
            logger.info(f"Loaded models configuration from {config_path}")
            return _cfg
    except Exception as e:
        logger.error(f"Failed to parse models.yml at {config_path}: {e}")
        return get_defaults()

def get_model(sector: str, provider: str) -> str:
    cfg = load_models()
    sec = cfg.get(sector) or cfg.get("semantic") or {}
    return sec.get(provider, "all-MiniLM-L6-v2")
