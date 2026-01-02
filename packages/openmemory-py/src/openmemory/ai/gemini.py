import httpx
import os
import asyncio
from typing import List, Dict, Any, Optional
from ..core.config import env
from .adapter import AIAdapter

TASK_MAP: Dict[str, str] = {
    "episodic": "RETRIEVAL_DOCUMENT",
    "semantic": "SEMANTIC_SIMILARITY",
    "procedural": "RETRIEVAL_DOCUMENT",
    "emotional": "CLASSIFICATION",
    "reflective": "SEMANTIC_SIMILARITY",
}

class GeminiAdapter(AIAdapter):
    """Adapter for Google's Gemini generative language models."""
    
    def __init__(self, api_key: str = None):
        """
        Initialize Gemini adapter.
        
        Args:
            api_key: Optional API key. Defaults to env/os var.
        """
        self.api_key = api_key or env.gemini_key or os.getenv("GEMINI_API_KEY")
        self.base_url = "https://generativelanguage.googleapis.com/v1beta"
        
    async def chat(self, messages: List[Dict[str, str]], model: str = None, **kwargs) -> str:
        """
        Send a chat request to Gemini.
        
        Args:
            messages: List of message dicts (role, content).
            model: Model name.
            **kwargs: Extra generation config.
            
        Returns:
            Model response text.
        """
        if not self.api_key: raise ValueError("Gemini key missing")
        m = model or "models/gemini-2.0-flash"
        if "models/" not in m: m = f"models/{m}"
        
        contents = []
        for msg in messages:
            role = "user" if msg["role"] == "user" else "model"
            content = msg["content"]
            if msg["role"] == "system":
                 content = f"System Instruction: {content}"
                 role = "user"
            
            contents.append({
                "role": role,
                "parts": [{ "text": content }]
            })
            
        url = f"{self.base_url}/{m}:generateContent?key={self.api_key}"
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            for attempt in range(3):
                try:
                    res = await client.post(url, json={
                        "contents": contents,
                        "generationConfig": kwargs
                    })
                    
                    if res.status_code == 429:
                        wait = min(2.0 ** attempt, 10.0)
                        await asyncio.sleep(wait)
                        continue
                        
                    if res.status_code != 200: 
                        raise Exception(f"Gemini Chat Error: {res.text}")
                        
                    data = res.json()
                    return data["candidates"][0]["content"]["parts"][0]["text"]
                except Exception as e:
                    if attempt == 2: raise e
                    await asyncio.sleep(1.0 * (2 ** attempt))
            return ""
        
    async def embed(self, text: str, model: str = None, sector: str = "semantic") -> List[float]:
        """Generate embeddings for a single text."""
        res = await self.embed_batch([text], model, sector)
        return res[0] if res else []
        
    async def embed_batch(self, texts: List[str], model: str = None, sector: str = "semantic") -> List[List[float]]:
        """
        Generate embeddings for a batch of texts.
        
        Args:
            texts: List of input strings.
            model: Embedding model name.
            sector: Sector for taskType mapping.
            
        Returns:
            List of embedding vectors.
        """
        if not self.api_key: raise ValueError("Gemini key missing")
        m = model or "models/text-embedding-004"
        if "models/" not in m: m = f"models/{m}"
        
        url = f"{self.base_url}/{m}:batchEmbedContents?key={self.api_key}"
        task_type = TASK_MAP.get(sector, "SEMANTIC_SIMILARITY")
        
        reqs = []
        for t in texts:
            reqs.append({
                "model": m,
                "content": { "parts": [{ "text": t }] },
                "taskType": task_type
            })
            
        async with httpx.AsyncClient(timeout=60.0) as client:
            for attempt in range(3):
                try:
                    res = await client.post(url, json={"requests": reqs})
                    if res.status_code == 429:
                        wait = min(2.0 ** attempt, 10.0)
                        await asyncio.sleep(wait)
                        continue
                        
                    if res.status_code != 200: raise Exception(f"Gemini: {res.text}")
                    
                    data = res.json()
                    if "embeddings" not in data: return []
                    return [e["values"] for e in data["embeddings"]]
                except Exception as e:
                    if attempt == 2: raise e
                    await asyncio.sleep(1.0 * (2 ** attempt))
            return []
