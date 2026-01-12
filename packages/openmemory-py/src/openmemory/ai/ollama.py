
import asyncio
import json
import logging
from typing import List, Dict, Any, Optional
import httpx
from .resilience import CircuitBreaker, with_resilience
from .exceptions import handle_provider_error, AIProviderError
from .adapter import AIAdapter
from ..core.config import env

logger = logging.getLogger("openmemory.ai.ollama")

class OllamaAdapter(AIAdapter):
    """Adapter for Ollama (local GenAI)."""

    def __init__(self, base_url: Optional[str] = None):
        self.base_url = (base_url or env.ollama_base_url or "http://localhost:11434").rstrip("/")
        self._breakers = {}

    def _get_breaker(self, model: str) -> CircuitBreaker:
        if model not in self._breakers:
            self._breakers[model] = CircuitBreaker(name=f"Ollama-{model}", failure_threshold=5)
        return self._breakers[model]

    async def chat(
        self, messages: List[Dict[str, str]], model: Optional[str] = None, **kwargs
    ) -> str:
        m = model or env.ollama_model or "llama3"
        breaker = self._get_breaker(m)
        url = f"{self.base_url}/api/chat"

        async def _call():
            async with httpx.AsyncClient(timeout=60.0) as client:
                try:
                    res = await client.post(url, json={
                        "model": m,
                        "messages": messages,
                        "stream": False,
                        **kwargs
                    })
                    if res.status_code != 200:
                        raise handle_provider_error("ollama", res)
                    return res.json()["message"]["content"]
                except Exception as e:
                    raise handle_provider_error("ollama", e)

        try:
            return await with_resilience(_call, breaker, should_retry=lambda e: getattr(e, 'retryable', True))
        except Exception as e:
            logger.error(f"[AI] Ollama error: {e}")
            raise

    async def chat_json(
        self, prompt: str, schema: Optional[Dict[str, Any]] = None, **kwargs
    ) -> Dict[str, Any]:
        """Ollama supports format='json'"""
        m = kwargs.get("model") or env.ollama_model or "llama3"
        breaker = self._get_breaker(m)
        url = f"{self.base_url}/api/chat"
        
        full_prompt = prompt
        if schema:
            full_prompt += f"\n\nFollow this JSON schema: {json.dumps(schema)}"

        async def _call():
            async with httpx.AsyncClient(timeout=60.0) as client:
                try:
                    res = await client.post(url, json={
                        "model": m,
                        "messages": [{"role": "user", "content": full_prompt}],
                        "stream": False,
                        "format": "json",
                        **{k: v for k, v in kwargs.items() if k != "model"}
                    })
                    if res.status_code != 200:
                        raise handle_provider_error("ollama", res)
                    return json.loads(res.json()["message"]["content"])
                except Exception as e:
                    raise handle_provider_error("ollama", e)

        try:
            return await with_resilience(_call, breaker, should_retry=lambda e: getattr(e, 'retryable', True))
        except Exception as e:
            logger.error(f"[AI] Ollama JSON error: {e}")
            raise

    async def embed(self, text: str, model: Optional[str] = None) -> List[float]:
        m = model or env.ollama_embedding_model or "nomic-embed-text"
        res = await self.embed_batch([text], m)
        return res[0] if res else []

    async def embed_batch(
        self, texts: List[str], model: Optional[str] = None
    ) -> List[List[float]]:
        if not texts: return []
        m = model or env.ollama_embedding_model or "nomic-embed-text"
        breaker = self._get_breaker(m)
        url = f"{self.base_url}/api/embeddings"

        async def _call():
            async with httpx.AsyncClient(timeout=60.0) as client:
                try:
                    tasks = [client.post(url, json={"model": m, "prompt": t}) for t in texts]
                    responses = await asyncio.gather(*tasks)
                    
                    results = []
                    for r in responses:
                        if r.status_code != 200:
                            raise handle_provider_error("ollama", r)
                        results.append(r.json()["embedding"])
                    return results
                except Exception as e:
                    raise handle_provider_error("ollama", e)

        try:
            return await with_resilience(_call, breaker, should_retry=lambda e: getattr(e, 'retryable', True))
        except Exception as e:
            logger.error(f"[AI] Ollama Embed error: {e}")
            raise
