import httpx
import asyncio
import logging
from typing import List, Dict, Any, Optional
from ..core.config import env
from .adapter import AIAdapter


logger = logging.getLogger("ai.ollama")

class OllamaAdapter(AIAdapter):
    def __init__(self, base_url: str = None):
        self.base_url = base_url or env.ollama_base_url or "http://localhost:11434"
        
    async def chat(self, messages: List[Dict[str, str]], model: str = None, **kwargs) -> str:
        m = model or env.ollama_model or "llama3"
        url = f"{self.base_url.rstrip('/')}/api/chat"
        # simple non-streaming implementation
        async with httpx.AsyncClient() as client:
            res = await client.post(url, json={
                "model": m,
                "messages": messages,
                "stream": False,
                **kwargs
            })
            if res.status_code != 200: raise Exception(f"Ollama: {res.text}")
            return res.json()["message"]["content"]
            
    async def embed(self, text: str, model: str = None) -> List[float]:
        m = model or env.ollama_embedding_model or "nomic-embed-text"
        return (await self.embed_batch([text], m))[0]
        
    async def embed_batch(self, texts: List[str], model: str = None) -> List[List[float]]:
        m = model or env.ollama_embedding_model or "nomic-embed-text"
        url = f"{self.base_url.rstrip('/')}/api/embeddings"
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            tasks = [client.post(url, json={"model": m, "prompt": t}) for t in texts]
            responses = await asyncio.gather(*tasks)
            
            res = []
            for i, r in enumerate(responses):
                if r.status_code != 200: 
                    logger.error(f"Ollama Emb Error for '{texts[i][:50]}...': {r.text}")
                    raise Exception(f"Ollama Emb: {r.text}")
                res.append(r.json()["embedding"])
            return res
