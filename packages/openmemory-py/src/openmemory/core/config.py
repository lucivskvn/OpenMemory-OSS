import os
import sys
from pathlib import Path
from typing import Literal, List, Optional, Any
from dotenv import load_dotenv

# load .env from project root
# assuming we are in src/openmemory/core aka 3 levels deep from root?
# backend was config({path: resolve(__dirname, "../../../.env")})
# we are in src/openmemory/core -> ../../../.env is correct
msg_root = Path(__file__).parent.parent.parent.parent / ".env"
load_dotenv(msg_root)

def num(v: Optional[str], d: int | float) -> int | float:
    try:
        return float(v) if v else d
    except ValueError:
        return d

def s_bool(v: Any) -> bool:
    if isinstance(v, bool): return v
    return str(v).lower() in ("true", "1", "yes", "on")

def s_str(v: Optional[str], d: str) -> str:
    return v if v else d

try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        tomllib = None

class EnvConfig:
    def __init__(self):
        # 1. Load TOML
        self._toml = {}
        toml_path = Path("openmemory.toml")
        if tomllib and toml_path.exists():
            with open(toml_path, "rb") as f:
                self._toml = tomllib.load(f)
        
        # Helper to get from TOML or Env
        def get(sec: str, key: str, env_var: str, default: Any) -> Any:
            val = self._toml.get(sec, {}).get(key)
            if val is not None: return val
            return os.getenv(env_var, default)

        # [db]
        # V2: url = "sqlite:///openmemory.db"
        self.db_url = get("db", "url", "OM_DB_URL", "sqlite:///openmemory.db")
        # Legacy back-compat for db_path if url is sqlite
        if self.db_url.startswith("sqlite:///"):
            self.db_path = self.db_url.replace("sqlite:///", "")
        else:
            # Fallback path if using legacy env
            default_db_path = str(Path(__file__).parent.parent.parent.parent / "data" / "openmemory.sqlite")
            self.db_path = s_str(os.getenv("OM_DB_PATH"), default_db_path)

        # [context]
        self.max_context_items = int(get("context", "max_items", "OM_MAX_CONTEXT_ITEMS", 16))
        self.max_context_tokens = int(get("context", "max_tokens", "OM_MAX_CONTEXT_TOKENS", 2048))

        # [decay]
        self.decay_half_life = float(get("decay", "half_life_days", "OM_DECAY_HALF_LIFE", 14))
        self.decay_lambda = num(os.getenv("OM_DECAY_LAMBDA"), 0.02) # legacy env
        self.decay_interval = int(num(get("decay", "interval_min", "OM_DECAY_INTERVAL", 5), 5))

        # [ai] or root params
        self.openai_key = get("ai", "openai_key", "OPENAI_API_KEY", "") or os.getenv("OM_OPENAI_API_KEY")
        self.openai_base_url = get("ai", "openai_base", "OM_OPENAI_BASE_URL", "https://api.openai.com/v1")
        self.openai_model = get("ai", "openai_model", "OM_OPENAI_MODEL", None)
        
        self.ollama_base_url = get("ai", "ollama_base_url", "OLLAMA_BASE_URL", "http://localhost:11434")
        self.ollama_model = get("ai", "ollama_model", "OLLAMA_MODEL", "llama3")
        
        self.tier = get("ai", "tier", "OM_TIER", "hybrid")
        self.emb_kind = get("ai", "embedding_provider", "OM_EMBED_KIND", "synthetic")
        self.embedding_fallback = get("ai", "embedding_fallback", "OM_EMBEDDING_FALLBACK", "synthetic").split(",")
        self.gemini_key = get("ai", "gemini_key", "GEMINI_API_KEY",  os.getenv("OM_GEMINI_KEY"))
        self.aws_region = get("ai", "aws_region", "AWS_REGION", None)
        self.aws_access_key_id = get("ai", "aws_access_key_id", "AWS_ACCESS_KEY_ID", None)
        self.aws_secret_access_key = get("ai", "aws_secret_access_key", "AWS_SECRET_ACCESS_KEY", None)

        # Legacy / Internal
        self.vec_dim = int(num(os.getenv("OM_VEC_DIM"), 1536))
        self.min_score = num(os.getenv("OM_MIN_SCORE"), 0.3)
        self.keyword_boost = num(os.getenv("OM_KEYWORD_BOOST"), 2.5)
        self.seg_size = int(num(os.getenv("OM_SEG_SIZE"), 10000))
        
        self.decay_threads = int(num(os.getenv("OM_DECAY_THREADS"), 3))
        self.decay_cold_threshold = num(os.getenv("OM_DECAY_COLD_THRESHOLD"), 0.25)
        self.max_vector_dim = int(num(os.getenv("OM_MAX_VECTOR_DIM"), 1536))
        self.min_vector_dim = int(num(os.getenv("OM_MIN_VECTOR_DIM"), 64))
        self.summary_layers = int(num(os.getenv("OM_SUMMARY_LAYERS"), 3))
        self.decay_ratio = num(os.getenv("OM_DECAY_RATIO"), 0.03)
        self.embed_delay_ms = int(num(os.getenv("OM_EMBED_DELAY_MS"), 0))
        self.use_summary_only = s_bool(os.getenv("OM_USE_SUMMARY_ONLY"))
        self.summary_max_length = int(num(os.getenv("OM_SUMMARY_MAX_LENGTH"), 200))
        self.rate_limit_enabled = s_bool(os.getenv("OM_RATE_LIMIT_ENABLED"))
        self.rate_limit_window_ms = int(num(os.getenv("OM_RATE_LIMIT_WINDOW_MS"), 60000))
        self.rate_limit_max_requests = int(num(os.getenv("OM_RATE_LIMIT_MAX"), 100))
        self.keyword_min_length = int(num(os.getenv("OM_KEYWORD_MIN_LENGTH"), 3))
        self.user_summary_interval = int(num(os.getenv("OM_USER_SUMMARY_INTERVAL"), 30))
        self.ollama_embedding_model = os.getenv("OM_OLLAMA_EMBEDDING_MODEL")
        self.gemini_embedding_model = os.getenv("OM_GEMINI_EMBEDDING_MODEL")
        self.aws_embedding_model = os.getenv("OM_AWS_EMBEDDING_MODEL")
        
        self.verbose = s_bool(os.getenv("OM_VERBOSE"))
        self.classifier_train_interval = int(num(os.getenv("OM_CLASSIFIER_TRAIN_INTERVAL"), 360))
        
        # [reflect]
        self.auto_reflect = s_bool(get("reflect", "enabled", "OM_AUTO_REFLECT", True))
        self.reflect_interval = int(num(get("reflect", "interval_min", "OM_REFLECT_INTERVAL", 10), 10))
        self.reflect_min = int(num(get("reflect", "min_mems", "OM_REFLECT_MIN", 20), 20))
        self.reflect_limit = int(num(get("reflect", "limit", "OM_REFLECT_LIMIT", 500), 500))
        
        # [maintenance]
        self.stats_retention_days = int(num(get("maintenance", "stats_retention_days", "OM_STATS_RETENTION", 30), 30))
        self.maintenance_interval_hours = int(num(get("maintenance", "interval_hours", "OM_MAINTENANCE_INTERVAL", 24), 24))

    def __repr__(self) -> str:
        # Mask secrets for safe logging/debugging
        def mask(s: str) -> str:
            if not s or len(s) < 8: return "***"
            return s[:4] + "..." + s[-4:]
            
        return (f"EnvConfig(tier='{self.tier}', db_url='{self.db_url}', "
                f"openai_key='{mask(self.openai_key)}', gemini_key='{mask(self.gemini_key)}', "
                f"aws_access_key_id='{mask(self.aws_access_key_id)}', HAS_AWS={bool(self.aws_secret_access_key)})")

    # Property for V2 access
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
            # Handle aliases/legacy
            if k == "path" and self.db_url.startswith("sqlite:///"):
                self.db_path = v
                self.db_url = f"sqlite:///{v}"
            elif k == "url":
                self.database_url = v
            elif k == "api_key":
                self.openai_key = v
            elif k == "embeddings":
                if isinstance(v, dict):
                    self.emb_kind = v.get("provider", self.emb_kind)
                    if self.emb_kind == "openai":
                        self.openai_key = v.get("apiKey", self.openai_key)
                        self.openai_model = v.get("model", self.openai_model)
                else:
                    self.emb_kind = v

env = EnvConfig()
