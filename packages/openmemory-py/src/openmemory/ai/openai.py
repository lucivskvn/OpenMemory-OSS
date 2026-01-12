import asyncio
import json
import logging
from typing import List, Dict, Any, Optional
from openai import AsyncOpenAI
from ..core.config import env
from .adapter import AIAdapter
from ..utils.logger import redact_text
from .resilience import CircuitBreaker, with_resilience
from .exceptions import handle_provider_error, AIProviderError

logger = logging.getLogger("openmemory.ai.openai")

class OpenAIAdapter(AIAdapter):
    """Adapter for OpenAI and OpenAI-compatible APIs."""

    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None):
        self.api_key = api_key or env.openai_key
        self.base_url = base_url or env.openai_base_url
        self.client = AsyncOpenAI(api_key=self.api_key, base_url=self.base_url, timeout=30.0)
        self._breakers = {}

    def _get_breaker(self, model: str) -> CircuitBreaker:
        if model not in self._breakers:
            self._breakers[model] = CircuitBreaker(name=f"OpenAI-{model}", failure_threshold=3)
        return self._breakers[model]

    async def chat(
        self, messages: List[Dict[str, str]], model: Optional[str] = None, **kwargs
    ) -> str:
        m = model or env.openai_model or "gpt-4o-mini"
        breaker = self._get_breaker(m)

        async def _call():
            try:
                res = await self.client.chat.completions.create(
                    model=m, messages=messages, **kwargs # type: ignore
                )
                return res.choices[0].message.content or ""
            except Exception as e:
                raise handle_provider_error("openai", e)

        try:
            return await with_resilience(_call, breaker, should_retry=lambda e: getattr(e, 'retryable', True))
        except Exception as e:
            logger.error(f"[AI] OpenAI error: {e}")
            raise

    async def chat_json(
        self, prompt: str, schema: Optional[Dict[str, Any]] = None, **kwargs
    ) -> Dict[str, Any]:
        m = kwargs.get("model") or env.openai_model or "gpt-4o-mini"
        breaker = self._get_breaker(m)
        
        system = "You are a helpful assistant that outputs JSON only."
        full_prompt = prompt
        if schema:
            full_prompt += f"\n\nFollow this JSON schema: {json.dumps(schema)}"

        async def _call():
            try:
                res = await self.client.chat.completions.create(
                    model=m,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": full_prompt}
                    ],
                    response_format={"type": "json_object"},
                    **{k: v for k, v in kwargs.items() if k != "model"}
                )
                content = res.choices[0].message.content or "{}"
                return json.loads(content)
            except Exception as e:
                raise handle_provider_error("openai", e)

        try:
            return await with_resilience(_call, breaker, should_retry=lambda e: getattr(e, 'retryable', True))
        except Exception as e:
            logger.error(f"[AI] OpenAI JSON error: {e}")
            raise

    async def embed(self, text: str, model: Optional[str] = None) -> List[float]:
        res = await self.embed_batch([text], model)
        return res[0] if res else []

    async def embed_batch(
        self, texts: List[str], model: Optional[str] = None
    ) -> List[List[float]]:
        if not texts: return []
        m = model or "text-embedding-3-small"
        breaker = self._get_breaker(m)

        async def _call():
            try:
                res = await self.client.embeddings.create(input=texts, model=m)
                return [d.embedding for d in res.data]
            except Exception as e:
                raise handle_provider_error("openai", e)

        try:
            return await with_resilience(_call, breaker, should_retry=lambda e: getattr(e, 'retryable', True))
        except Exception as e:
            logger.error(f"[AI] OpenAI Embed error: {e}")
            raise
