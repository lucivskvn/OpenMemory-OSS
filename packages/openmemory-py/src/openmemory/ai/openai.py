import asyncio
import logging
from typing import List, Dict, Any, Optional
from openai import AsyncOpenAI
from ..core.config import env
from .adapter import AIAdapter

logger = logging.getLogger("openmemory.ai.openai")

class OpenAIAdapter(AIAdapter):
    """Adapter for OpenAI and OpenAI-compatible APIs."""
    
    def __init__(self, api_key: str = None, base_url: str = None):
        """
        Initialize OpenAI adapter.
        
        Args:
            api_key: Optional API key.
            base_url: Optional base URL (e.g. for local proxy or Azure).
        """
        self.api_key = api_key or env.openai_key
        self.base_url = base_url or env.openai_base_url
        self.client = AsyncOpenAI(api_key=self.api_key, base_url=self.base_url, timeout=30.0)
        
    async def chat(self, messages: List[Dict[str, str]], model: str = None, **kwargs) -> str:
        """
        Send a chat completion request with retries.
        
        Args:
            messages: List of message objects.
            model: Model name override.
            **kwargs: Extra completion options.
            
        Returns:
            Model response content.
        """
        m = model or env.openai_model or "gpt-4o-mini"
        
        for attempt in range(3):
            try:
                res = await self.client.chat.completions.create(
                    model=m,
                    messages=messages,
                    **kwargs
                )
                return res.choices[0].message.content or ""
            except Exception as e:
                if "rate_limit" in str(e).lower() or "429" in str(e):
                    wait = 2 ** attempt
                    logger.warning(f"OpenAI rate limit hit, waiting {wait}s...")
                    await asyncio.sleep(wait)
                    continue
                if attempt == 2: raise e
                await asyncio.sleep(1.0)
        return ""
        
    async def embed(self, text: str, model: str = None) -> List[float]:
        """Generate a single embedding."""
        res = await self.embed_batch([text], model)
        return res[0] if res else []
        
    async def embed_batch(self, texts: List[str], model: str = None) -> List[List[float]]:
        """
        Generate a batch of embeddings with retries.
        
        Args:
            texts: List of strings.
            model: Embedding model name.
            
        Returns:
            List of vectors.
        """
        m = model or "text-embedding-3-small"
        for attempt in range(3):
            try:
                res = await self.client.embeddings.create(input=texts, model=m)
                return [d.embedding for d in res.data]
            except Exception as e:
                if "rate_limit" in str(e).lower() or "429" in str(e):
                    await asyncio.sleep(2 ** attempt)
                    continue
                if attempt == 2: raise e
                await asyncio.sleep(1.0)
        return []
