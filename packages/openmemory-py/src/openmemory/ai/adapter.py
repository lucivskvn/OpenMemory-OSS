from typing import List, Dict, Any, Optional
from abc import ABC, abstractmethod

class AIAdapter(ABC):
    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}

    @abstractmethod
    async def chat(
        self, messages: List[Dict[str, str]], model: Optional[str] = None, **kwargs
    ) -> str:
        """Simple chat completion"""
        pass

    @abstractmethod
    async def chat_json(
        self, prompt: str, schema: Optional[Dict[str, Any]] = None, **kwargs
    ) -> Dict[str, Any]:
        """Generate JSON response"""
        pass

    @abstractmethod
    async def embed(self, text: str, model: Optional[str] = None) -> List[float]:
        """Generate single embedding"""
        pass

    @abstractmethod
    async def embed_batch(
        self, texts: List[str], model: Optional[str] = None
    ) -> List[List[float]]:
        """Generate batch embeddings"""
        pass
