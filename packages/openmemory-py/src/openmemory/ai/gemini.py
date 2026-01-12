import asyncio
import json
import logging
import os
from typing import List, Dict, Any, Optional
import httpx
from .resilience import CircuitBreaker, with_resilience
from .exceptions import handle_provider_error, AIProviderError
from .adapter import AIAdapter
from ..core.config import env
from ..utils.logger import redact_text

logger = logging.getLogger("openmemory.ai.gemini")

TASK_MAP: Dict[str, str] = {
    "episodic": "RETRIEVAL_DOCUMENT",
    "semantic": "SEMANTIC_SIMILARITY",
    "procedural": "RETRIEVAL_DOCUMENT",
    "emotional": "CLASSIFICATION",
    "reflective": "SEMANTIC_SIMILARITY",
}

class GeminiAdapter(AIAdapter):
    """Adapter for Google's Gemini generative language models (REST)."""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or env.gemini_key or os.getenv("GEMINI_API_KEY")
        self.base_url = "https://generativelanguage.googleapis.com/v1beta"
        self._breakers = {}

    def _get_breaker(self, model: str) -> CircuitBreaker:
        if model not in self._breakers:
            self._breakers[model] = CircuitBreaker(name=f"Gemini-{model}", failure_threshold=3)
        return self._breakers[model]

    async def chat(
        self, messages: List[Dict[str, str]], model: Optional[str] = None, **kwargs
    ) -> str:
        m = model or "models/gemini-2.0-flash"
        if "models/" not in m: m = f"models/{m}"
        breaker = self._get_breaker(m)

        contents = []
        for msg in messages:
            role = "user" if msg["role"] == "user" else "model"
            content = msg["content"]
            if msg["role"] == "system":
                content = f"System Instruction: {content}"
                role = "user"
            contents.append({"role": role, "parts": [{"text": content}]})

        url = f"{self.base_url}/{m}:generateContent"
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": self.api_key or ""
        }

        async def _call():
            async with httpx.AsyncClient(timeout=60.0) as client:
                try:
                    res = await client.post(url, headers=headers, json={
                        "contents": contents,
                        "generationConfig": kwargs
                    })
                    if res.status_code != 200:
                        raise handle_provider_error("gemini", res)  # type: ignore[arg-type]  # type: ignore[arg-type]
                    
                    data = res.json()
                    return data["candidates"][0]["content"]["parts"][0]["text"]
                except Exception as e:
                    raise handle_provider_error("gemini", e)

        try:
            return await with_resilience(_call, breaker, should_retry=lambda e: getattr(e, 'retryable', True))
        except Exception as e:
            logger.error(f"[AI] Gemini error: {e}")
            raise

    async def chat_json(
        self, prompt: str, schema: Optional[Dict[str, Any]] = None, **kwargs
    ) -> Dict[str, Any]:
        m = kwargs.get("model") or "models/gemini-2.0-flash"
        if "models/" not in m: m = f"models/{m}"
        breaker = self._get_breaker(m)

        url = f"{self.base_url}/{m}:generateContent"
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": self.api_key or ""
        }
        
        full_prompt = prompt
        if schema:
            full_prompt += f"\n\nFollow this JSON schema: {json.dumps(schema)}"

        async def _call():
            async with httpx.AsyncClient(timeout=60.0) as client:
                try:
                    res = await client.post(url, headers=headers, json={
                        "contents": [{"role": "user", "parts": [{"text": full_prompt}]}],
                        "generationConfig": {
                            **{k: v for k, v in kwargs.items() if k != "model"},
                            "responseMimeType": "application/json"
                        }
                    })
                    if res.status_code != 200:
                        raise handle_provider_error("gemini", res)  # type: ignore[arg-type]  # type: ignore[arg-type]
                    
                    data = res.json()
                    text = data["candidates"][0]["content"]["parts"][0]["text"]
                    return json.loads(text)
                except Exception as e:
                    raise handle_provider_error("gemini", e)

        try:
            return await with_resilience(_call, breaker, should_retry=lambda e: getattr(e, 'retryable', True))
        except Exception as e:
            logger.error(f"[AI] Gemini JSON error: {e}")
            raise

    async def embed(
        self, text: str, model: Optional[str] = None, sector: str = "semantic"
    ) -> List[float]:
        res = await self.embed_batch([text], model, sector)
        return res[0] if res else []

    async def embed_batch(
        self, texts: List[str], model: Optional[str] = None, sector: str = "semantic"
    ) -> List[List[float]]:
        if not texts: return []
        m = model or "models/text-embedding-004"
        if "models/" not in m: m = f"models/{m}"
        breaker = self._get_breaker(m)
        
        url = f"{self.base_url}/{m}:batchEmbedContents"
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": self.api_key or ""
        }
        task_type = TASK_MAP.get(sector, "SEMANTIC_SIMILARITY")
        
        reqs = []
        for t in texts:
            reqs.append({
                "model": m,
                "content": { "parts": [{ "text": t }] },
                "taskType": task_type
            })

        async def _call():
            async with httpx.AsyncClient(timeout=60.0) as client:
                try:
                    res = await client.post(url, headers=headers, json={"requests": reqs})
                    if res.status_code != 200:
                        raise handle_provider_error("gemini", res)  # type: ignore[arg-type]  # type: ignore[arg-type]
                    
                    data = res.json()
                    if "embeddings" not in data: return []
                    return [e["values"] for e in data["embeddings"]]
                except Exception as e:
                    raise handle_provider_error("gemini", e)

        try:
            return await with_resilience(_call, breaker, should_retry=lambda e: getattr(e, 'retryable', True))
        except Exception as e:
            logger.error(f"[AI] Gemini Embed error: {e}")
            raise
