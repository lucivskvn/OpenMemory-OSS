import os
import sys
from pathlib import Path
from typing import Literal, List, Optional, Any, Dict, Union, TypeVar, overload
from dotenv import load_dotenv
from pydantic import BaseModel, Field, PrivateAttr

# load .env from project root
msg_root = Path(__file__).parent.parent.parent.parent / ".env"
load_dotenv(msg_root)

try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        tomllib = None

def get_base_db_path():
    return str(Path(__file__).parent.parent.parent.parent / "data" / "openmemory.sqlite")

class OpenMemoryConfig(BaseModel):
    # Core
    port: int = 8080
    mode: str = "standard"
    db_url: str = Field(default="sqlite:///openmemory.db")
    db_path: str = Field(default_factory=lambda: os.getenv("OM_DB_PATH", get_base_db_path()))
    
    # Context
    max_context_items: int = 16
    max_context_tokens: int = 2048
    
    # Decay
    decay_half_life: float = 14.0
    decay_lambda: float = 0.02
    decay_interval: int = 5
    decay_threads: int = 3
    decay_cold_threshold: float = 0.25
    decay_ratio: float = 0.03
    
    # AI / Embeddings
    tier: str = "hybrid"
    emb_kind: str = "synthetic"
    embedding_fallback: List[str] = ["synthetic"]
    embed_delay_ms: int = 200
    
    openai_key: Optional[str] = None
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: Optional[str] = None
    
    gemini_key: Optional[str] = None
    gemini_model: Optional[str] = None
    
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3"
    
    aws_region: Optional[str] = None
    aws_access_key_id: Optional[str] = None
    aws_secret_access_key: Optional[str] = None
    
    # Vector / HSG
    vec_dim: int = 1536
    min_score: float = 0.3
    keyword_boost: float = 2.5
    seg_size: int = 10000
    max_vector_dim: int = 1536
    min_vector_dim: int = 64
    summary_layers: int = 3
    
    # Features
    use_summary_only: bool = True
    summary_max_length: int = 200
    rate_limit_enabled: bool = False
    rate_limit_window_ms: int = 60000
    rate_limit_max_requests: int = 100
    keyword_min_length: int = 3
    user_summary_interval: int = 30
    
    ollama_embedding_model: Optional[str] = None
    gemini_embedding_model: Optional[str] = None
    aws_embedding_model: Optional[str] = None
    
    verbose: bool = False
    classifier_train_interval: int = 360
    
    # Reflect
    auto_reflect: bool = True
    reflect_interval: int = 10
    reflect_min: int = 20
    reflect_limit: int = 500
    
    # Maintenance
    stats_retention_days: int = 30
    maintenance_interval_hours: int = 24
    
    # HSG Weights
    scoring_similarity: float = 1.0
    scoring_overlap: float = 0.5
    scoring_waypoint: float = 0.3
    scoring_recency: float = 0.2
    scoring_tag_match: float = 0.4
    
    reinf_salience_boost: float = 0.1
    reinf_waypoint_boost: float = 0.05
    reinf_max_salience: float = 1.0
    reinf_max_waypoint_weight: float = 1.0
    reinf_prune_threshold: float = 0.1
    
    decay_episodic: float = 0.015
    decay_semantic: float = 0.005
    decay_procedural: float = 0.008
    decay_emotional: float = 0.02
    decay_reflective: float = 0.001
    
    # Security
    encryption_enabled: bool = False
    encryption_key: Optional[str] = None
    encryption_secondary_keys: Optional[List[str]] = None
    
    # Database
    max_threads: int = 10
    pg_schema: str = "public"
    pg_table: str = "memories"
    users_table: str = "users"
    vector_table: str = "vectors"
    
    # Vector Store
    vector_store_backend: str = "sqlite"
    
    # AI
    emb_fallback: Optional[List[str]] = None
    
    # Server
    server_api_key: Optional[str] = None

    @property
    def database_url(self) -> str:
        return self.db_url

    @database_url.setter
    def database_url(self, val: str):
        self.db_url = val
        if val.startswith("sqlite:///"):
            self.db_path = val.replace("sqlite:///", "")

    def update_config(self, **kwargs):
        """Programmatically update config values at runtime."""
        for k, v in kwargs.items():
            if hasattr(self, k):
                setattr(self, k, v)
            
            # Legacy handling from original class
            if k == "path" and self.db_url.startswith("sqlite:///"):
                self.db_path = v
                self.db_url = f"sqlite:///{v}"
            elif k == "url":
                self.database_url = v
            elif k == "api_key":
                self.openai_key = v
            elif k == "embeddings" and isinstance(v, dict):
                self.emb_kind = v.get("provider", self.emb_kind)
                if self.emb_kind == "openai":
                    self.openai_key = v.get("apiKey", self.openai_key)
                    self.openai_model = v.get("model", self.openai_model)
            elif k == "embeddings" and isinstance(v, str):
                self.emb_kind = v

    def __repr__(self) -> str:
        s_key = "***" if not self.openai_key else f"{self.openai_key[:4]}...{self.openai_key[-4:]}"
        return f"OpenMemoryConfig(tier='{self.tier}', db_url='{self.db_url}', openai_key='{s_key}')"

# --- Loader Logic ---
def load_config() -> OpenMemoryConfig:
    toml_data = {}
    toml_path = Path("openmemory.toml")
    if tomllib and toml_path.exists():
        try:
            with open(toml_path, "rb") as f:
                toml_data = tomllib.load(f)
        except Exception:
            pass

    def get(sec: str, key: str, env_var: str, default: Any) -> Any:
        # TOML > ENV > Default
        val = toml_data.get(sec, {}).get(key)
        if val is not None: return val
        return os.getenv(env_var, default)

    def s_bool(v: Any) -> bool:
        if isinstance(v, bool): return v
        return str(v).lower() in ("true", "1", "yes", "on")

    # Map Values
    data = {}
    
    # Core
    data["port"] = int(os.getenv("PORT", 3000)) # Note: old code used 3000 for server, 8080 default elsewhere? Let's match old code: 3000
    data["mode"] = os.getenv("OM_MODE", "standard").lower()
    data["db_url"] = get("db", "url", "OM_DB_URL", "sqlite:///openmemory.db")
    
    # Context
    data["max_context_items"] = int(get("context", "max_items", "OM_MAX_CONTEXT_ITEMS", 16))
    data["max_context_tokens"] = int(get("context", "max_tokens", "OM_MAX_CONTEXT_TOKENS", 2048))

    # Decay
    data["decay_half_life"] = float(get("decay", "half_life_days", "OM_DECAY_HALF_LIFE", 14))
    data["decay_lambda"] = float(os.getenv("OM_DECAY_LAMBDA", 0.02))
    data["decay_interval"] = int(get("decay", "interval_min", "OM_DECAY_INTERVAL", 5))

    # AI
    data["openai_key"] = get("ai", "openai_key", "OPENAI_API_KEY", "") or os.getenv("OM_OPENAI_API_KEY")
    data["openai_base_url"] = get("ai", "openai_base", "OM_OPENAI_BASE_URL", "https://api.openai.com/v1")
    data["openai_model"] = get("ai", "openai_model", "OM_OPENAI_MODEL", None)
    
    data["ollama_base_url"] = get("ai", "ollama_base_url", "OLLAMA_BASE_URL", "http://localhost:11434")
    data["ollama_model"] = get("ai", "ollama_model", "OLLAMA_MODEL", "llama3")
    
    data["tier"] = get("ai", "tier", "OM_TIER", "hybrid")
    data["emb_kind"] = get("ai", "embedding_provider", "OM_EMBED_KIND", "synthetic")
    
    fallback = get("ai", "embedding_fallback", "OM_EMBEDDING_FALLBACK", "synthetic")
    data["embedding_fallback"] = fallback.split(",") if isinstance(fallback, str) else fallback
    
    data["gemini_key"] = get("ai", "gemini_key", "GEMINI_API_KEY", os.getenv("OM_GEMINI_KEY"))
    data["aws_region"] = get("ai", "aws_region", "AWS_REGION", None)
    data["aws_access_key_id"] = get("ai", "aws_access_key_id", "AWS_ACCESS_KEY_ID", None)
    data["aws_secret_access_key"] = get("ai", "aws_secret_access_key", "AWS_SECRET_ACCESS_KEY", None)

    # Legacy/Flat Env Vars
    T = TypeVar('T', int, float, bool, str)
    
    def env_or(key: str, default: T, type_cast: type[T] = str) -> T:  # type: ignore[assignment]
        v = os.getenv(key)
        if v is None: return default
        if type_cast == bool: return s_bool(v)  # type: ignore[return-value]
        try: return type_cast(v)  # type: ignore[call-arg, return-value]
        except: return default

    data["vec_dim"] = env_or("OM_VEC_DIM", 1536, int)
    data["min_score"] = env_or("OM_MIN_SCORE", 0.3, float)
    data["keyword_boost"] = env_or("OM_KEYWORD_BOOST", 2.5, float)
    data["seg_size"] = env_or("OM_SEG_SIZE", 10000, int)
    data["decay_threads"] = env_or("OM_DECAY_THREADS", 3, int)
    data["decay_cold_threshold"] = env_or("OM_DECAY_COLD_THRESHOLD", 0.25, float)
    data["max_vector_dim"] = env_or("OM_MAX_VECTOR_DIM", 1536, int)
    data["min_vector_dim"] = env_or("OM_MIN_VECTOR_DIM", 64, int)
    data["summary_layers"] = env_or("OM_SUMMARY_LAYERS", 3, int)
    data["decay_ratio"] = env_or("OM_DECAY_RATIO", 0.03, float)
    data["embed_delay_ms"] = env_or("OM_EMBED_DELAY_MS", 200, int)
    data["use_summary_only"] = env_or("OM_USE_SUMMARY_ONLY", True, bool)
    data["summary_max_length"] = env_or("OM_SUMMARY_MAX_LENGTH", 200, int)
    data["rate_limit_enabled"] = env_or("OM_RATE_LIMIT_ENABLED", False, bool)
    data["rate_limit_window_ms"] = env_or("OM_RATE_LIMIT_WINDOW_MS", 60000, int)
    data["rate_limit_max_requests"] = env_or("OM_RATE_LIMIT_MAX", 100, int)
    data["keyword_min_length"] = env_or("OM_KEYWORD_MIN_LENGTH", 3, int)
    data["user_summary_interval"] = env_or("OM_USER_SUMMARY_INTERVAL", 30, int)
    
    data["ollama_embedding_model"] = os.getenv("OM_OLLAMA_EMBEDDING_MODEL")
    data["gemini_embedding_model"] = os.getenv("OM_GEMINI_EMBEDDING_MODEL")
    data["aws_embedding_model"] = os.getenv("OM_AWS_EMBEDDING_MODEL")
    
    data["verbose"] = env_or("OM_VERBOSE", False, bool)
    data["classifier_train_interval"] = env_or("OM_CLASSIFIER_TRAIN_INTERVAL", 360, int)
    data["server_api_key"] = os.getenv("API_KEY")

    # Reflect
    data["auto_reflect"] = s_bool(get("reflect", "enabled", "OM_AUTO_REFLECT", True))
    data["reflect_interval"] = int(get("reflect", "interval_min", "OM_REFLECT_INTERVAL", 10))
    data["reflect_min"] = int(get("reflect", "min_mems", "OM_REFLECT_MIN", 20))
    data["reflect_limit"] = int(get("reflect", "limit", "OM_REFLECT_LIMIT", 500))

    # Maintenance
    data["stats_retention_days"] = int(get("maintenance", "stats_retention_days", "OM_STATS_RETENTION", 30))
    data["maintenance_interval_hours"] = int(get("maintenance", "interval_hours", "OM_MAINTENANCE_INTERVAL", 24))

    # HSG Weights
    data["scoring_similarity"] = env_or("OM_SCORING_SIMILARITY", 1.0, float)
    data["scoring_overlap"] = env_or("OM_SCORING_OVERLAP", 0.5, float)
    data["scoring_waypoint"] = env_or("OM_SCORING_WAYPOINT", 0.3, float)
    data["scoring_recency"] = env_or("OM_SCORING_RECENCY", 0.2, float)
    data["scoring_tag_match"] = env_or("OM_SCORING_TAG_MATCH", 0.4, float)

    data["reinf_salience_boost"] = env_or("OM_REINF_SALIENCE_BOOST", 0.1, float)
    data["reinf_waypoint_boost"] = env_or("OM_REINF_WAYPOINT_BOOST", 0.05, float)
    data["reinf_max_salience"] = env_or("OM_REINF_MAX_SALIENCE", 1.0, float)
    data["reinf_max_waypoint_weight"] = env_or("OM_REINF_MAX_WAYPOINT_WEIGHT", 1.0, float)
    data["reinf_prune_threshold"] = env_or("OM_REINF_PRUNE_THRESHOLD", 0.1, float)

    data["decay_episodic"] = env_or("OM_DECAY_EPISODIC", 0.015, float)
    data["decay_semantic"] = env_or("OM_DECAY_SEMANTIC", 0.005, float)
    data["decay_procedural"] = env_or("OM_DECAY_PROCEDURAL", 0.008, float)
    data["decay_emotional"] = env_or("OM_DECAY_EMOTIONAL", 0.02, float)
    data["decay_reflective"] = env_or("OM_DECAY_REFLECTIVE", 0.001, float)

    return OpenMemoryConfig(**data)

env = load_config()

# Backwards compatibility logic for sqlite path initialization
if env.db_url.startswith("sqlite:///"):
    env.db_path = env.db_url.replace("sqlite:///", "")
    # Original logic had custom fallback for non-url OM_DB_PATH, 
    # but the loader above prioritizes DB_URL. 
    # If OM_DB_PATH was set but OM_DB_URL wasn't, the default for DB_URL was used, overriding path.
    # The Pydantic Field default factory for db_path handles the raw env var if db_url is default.
    # If db_url is explicit, it overrides db_path.

