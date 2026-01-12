
from typing import Optional
from ..utils.logger import redact_text

class AIException(Exception):
    """Base exception for all AI-related errors."""
    pass

class AIProviderError(AIException):
    """Exception raised for specific AI provider errors (4xx, 5xx, timeouts)."""
    def __init__(self, message: str, provider: str, code: Optional[str] = None, retryable: bool = True):
        # Redact potentially sensitive info from message
        redacted_msg = redact_text(message)
        super().__init__(redacted_msg)
        self.message = redacted_msg
        self.provider = provider
        self.code = code
        self.retryable = retryable

    def __str__(self):
        return f"[{self.provider}] {self.code or 'ERROR'}: {self.message}"

def handle_provider_error(provider: str, error: Exception) -> AIProviderError:
    """Standardized error handler for AI providers (parity with JS)."""
    if isinstance(error, AIProviderError):
        return error
        
    msg = str(error)
    code = "UNKNOWN"
    retryable = True
    
    # Generic status/code extraction logic if available on the error object
    status = getattr(error, 'status_code', getattr(error, 'status', None))
    
    if status == 429:
        msg = "Rate limit exceeded"
        code = "RATE_LIMIT"
    elif status in (401, 403):
        msg = "Authentication failed"
        code = "AUTH_ERROR"
        retryable = False
    elif status and int(status) >= 500:
        msg = "Provider server error"
        code = "SERVER_ERROR"
    elif "timeout" in msg.lower() or "abort" in msg.lower():
        msg = "Request timeout or aborted"
        code = "TIMEOUT"

    return AIProviderError(msg, provider, code, retryable)
