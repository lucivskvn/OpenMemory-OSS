class OpenMemoryError(Exception):
    """Base class for all OpenMemory exceptions."""
    pass

class ConfigurationError(OpenMemoryError):
    """Raised when configuration is invalid."""
    pass

class ProviderError(OpenMemoryError):
    """Raised when an AI provider fails."""
    pass

class CircuitOpenError(OpenMemoryError):
    """Raised when the circuit breaker is open."""
    pass

class RetryTimeoutError(OpenMemoryError):
    """Raised when retries are exhausted or timed out."""
    pass
