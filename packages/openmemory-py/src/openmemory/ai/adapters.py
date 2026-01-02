
from typing import Optional
from .adapter import AIAdapter
from .openai import OpenAIAdapter
from .gemini import GeminiAdapter
from .ollama import OllamaAdapter
from .aws import AwsAdapter
from .synthetic import SyntheticAdapter
from ..core.config import env

_adapter_instance: Optional[AIAdapter] = None

def get_adapter() -> AIAdapter:
    global _adapter_instance
    if _adapter_instance:
        return _adapter_instance
        
    # Priority: OpenAI > Gemini > Ollama > AWS > Synthetic
    # This can be refined with specific env vars like OM_AI_PROVIDER if needed
    
    if env.openai_key:
        _adapter_instance = OpenAIAdapter()
    elif env.gemini_key:
        _adapter_instance = GeminiAdapter()
    elif env.ollama_base_url:
        # Check if Ollama is actually reachable? For now just assume if configured.
        # But ollama_base_url has a default localhost.
        # Maybe check if it's explicitly set or we just default to it?
        # Defaults to localhost. So minimal risk.
        _adapter_instance = OllamaAdapter()
    elif env.aws_access_key_id:
        _adapter_instance = AwsAdapter()
    else:
        _adapter_instance = SyntheticAdapter()
        
    return _adapter_instance

def reset_adapter():
    global _adapter_instance
    _adapter_instance = None
