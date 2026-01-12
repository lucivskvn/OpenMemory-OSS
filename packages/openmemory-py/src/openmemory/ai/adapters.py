from typing import Optional, Dict, Any, List
from .adapter import AIAdapter
from .openai import OpenAIAdapter
from .gemini import GeminiAdapter
from .ollama import OllamaAdapter
from .aws import AwsAdapter
from .synthetic import SyntheticAdapter
from .resilience import CircuitState
from ..core.config import env
from ..core.db import q

import logging
logger = logging.getLogger("openmemory.ai.failover")

class FailoverAdapter(AIAdapter):
    """Adapter that tries multiple providers in sequence until one succeeds."""
    def __init__(self, adapters: List[AIAdapter]):
        super().__init__()
        self.adapters = adapters

    async def chat(self, messages: List[Dict[str, str]], model: Optional[str] = None, **kwargs) -> str:
        last_err = None
        for i, adapter in enumerate(self.adapters):
            try:
                # Optimized check: Skip if circuit is OPEN
                if hasattr(adapter, "_breakers"):
                    m = model or "default"
                    breaker = adapter._breakers.get(m)
                    if breaker and breaker.state == CircuitState.OPEN:
                        logger.warning(f"[Failover] Skipping {adapter.__class__.__name__} (Circuit OPEN)")
                        continue

                return await adapter.chat(messages, model, **kwargs)
            except Exception as e:
                logger.error(f"[Failover] Adapter {i} ({adapter.__class__.__name__}) failed: {e}")
                last_err = e
        
        if last_err: raise last_err
        return ""

    async def chat_json(self, prompt: str, schema: Optional[Dict[str, Any]] = None, **kwargs) -> Dict[str, Any]:
        last_err = None
        for i, adapter in enumerate(self.adapters):
            try:
                if hasattr(adapter, "_breakers"):
                    m = kwargs.get("model") or "default"
                    breaker = adapter._breakers.get(m)
                    if breaker and breaker.state == CircuitState.OPEN: continue

                return await adapter.chat_json(prompt, schema, **kwargs)
            except Exception as e:
                logger.error(f"[Failover] Adapter {i} ({adapter.__class__.__name__}) failed: {e}")
                last_err = e
        
        if last_err: raise last_err
        return {}

    async def embed(self, text: str, model: Optional[str] = None) -> List[float]:
        last_err = None
        for i, adapter in enumerate(self.adapters):
            try:
                return await adapter.embed(text, model)
            except Exception as e:
                logger.error(f"[Failover] Adapter {i} ({adapter.__class__.__name__}) failed: {e}")
                last_err = e
        if last_err: raise last_err
        return []

    async def embed_batch(self, texts: List[str], model: Optional[str] = None) -> List[List[float]]:
        last_err = None
        for i, adapter in enumerate(self.adapters):
            try:
                return await adapter.embed_batch(texts, model)
            except Exception as e:
                logger.error(f"[Failover] Adapter {i} ({adapter.__class__.__name__}) failed: {e}")
                last_err = e
        if last_err: raise last_err
        return []

class AdapterFactory:
    def __init__(self):
        self._system_adapter: Optional[AIAdapter] = None
        self._user_adapters: Dict[str, AIAdapter] = {}

    async def _load_user_config(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Load user-specific AI config from database metadata."""
        try:
            user = await q.get_user(user_id)
            if not user or not user.get("metadata"):
                return None
            
            metadata = json.loads(user["metadata"])
            return metadata.get("ai_config") or metadata.get("saas_config")
        except Exception:
            return None

    async def get_adapter(self, user_id: Optional[str] = None) -> AIAdapter:
        # 1. Check user cache
        if user_id and user_id in self._user_adapters:
            return self._user_adapters[user_id]
        
        # 2. Check system singleton if no user_id or cache miss
        if not user_id and self._system_adapter:
            return self._system_adapter

        # 3. Load user-specific config if available
        user_cfg = None
        if user_id:
            user_cfg = await self._load_user_config(user_id)

        # 4. Create new adapter 
        # For SaaS, if user_cfg has keys, they override system env
        
        target_openai_key = (user_cfg or {}).get("openai_key") or env.openai_key
        target_gemini_key = (user_cfg or {}).get("gemini_key") or env.gemini_key
        target_ollama_url = (user_cfg or {}).get("ollama_base_url") or env.ollama_base_url
        target_aws_id = (user_cfg or {}).get("aws_access_key_id") or env.aws_access_key_id

        # Prioritize explicit kind
        kind = (user_cfg or {}).get("embedding_provider") or env.emb_kind

        adapter: AIAdapter
        
        if kind == "synthetic":
            adapter = SyntheticAdapter()
        elif kind == "openai" and target_openai_key:
            adapter = OpenAIAdapter(api_key=target_openai_key, base_url=(user_cfg or {}).get("openai_base_url") or env.openai_base_url)
        elif kind == "gemini" and target_gemini_key:
             adapter = GeminiAdapter(api_key=target_gemini_key)
        elif kind == "ollama" and target_ollama_url:
             adapter = OllamaAdapter(base_url=target_ollama_url)
        elif kind == "aws" and target_aws_id:
             adapter = AwsAdapter(
                access_key=target_aws_id,
                secret_key=(user_cfg or {}).get("aws_secret_access_key") or env.aws_secret_access_key,
                region=(user_cfg or {}).get("aws_region") or env.aws_region
            )
        else:
             # Fallback to key detection if kind is not explicit or matching
            if target_openai_key:
                adapter = OpenAIAdapter(api_key=target_openai_key, base_url=(user_cfg or {}).get("openai_base_url") or env.openai_base_url)
            elif target_gemini_key:
                adapter = GeminiAdapter(api_key=target_gemini_key)
            elif target_ollama_url:
                adapter = OllamaAdapter(base_url=target_ollama_url)
            elif target_aws_id:
                adapter = AwsAdapter(
                    access_key=target_aws_id,
                    secret_key=(user_cfg or {}).get("aws_secret_access_key") or env.aws_secret_access_key,
                    region=(user_cfg or {}).get("aws_region") or env.aws_region
                )
            else:
                adapter = SyntheticAdapter()

        if user_id:
            self._user_adapters[user_id] = adapter
        else:
            self._system_adapter = adapter

        # --- Failover Layer ---
        # If fallback is enabled or multiple providers exist, wrap in FailoverAdapter
        # For simplicity, if OpenAI is primary and Gemini exists, we add Gemini as fallback.
        
        fallbacks = []
        if env.emb_fallback:
             # Add secondary if not the primary
             if target_gemini_key and kind != "gemini":
                 fallbacks.append(GeminiAdapter(api_key=target_gemini_key))
             if target_openai_key and kind != "openai":
                 fallbacks.append(OpenAIAdapter(api_key=target_openai_key))
             if target_ollama_url and kind != "ollama":
                 fallbacks.append(OllamaAdapter(base_url=target_ollama_url))
        
        if fallbacks:
            logger.info(f"[AI] Initializing Failover with {len(fallbacks)} fallbacks for {user_id or 'system'}")
            return FailoverAdapter([adapter] + fallbacks)
            
        return adapter

    def reset(self):
        self._system_adapter = None
        self._user_adapters.clear()

_factory = AdapterFactory()

async def get_adapter(user_id: Optional[str] = None) -> AIAdapter:
    return await _factory.get_adapter(user_id)

def reset_adapter():
    _factory.reset()
