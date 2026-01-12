
import asyncio
import time
import random
import logging
from enum import Enum
from typing import Callable, TypeVar, Any, Optional
from ..core.errors import CircuitOpenError, RetryTimeoutError

logger = logging.getLogger("resilience")

T = TypeVar("T")

class CircuitState(Enum):
    CLOSED = "CLOSED"      # Normal operation
    OPEN = "OPEN"          # Failing, request blocked
    HALF_OPEN = "HALF_OPEN" # Testing recovery

class CircuitBreaker:
    def __init__(self, name: str = "CircuitBreaker", failure_threshold: int = 5, reset_timeout: float = 60.0):
        self.name = name
        self.failure_threshold = failure_threshold
        self.reset_timeout = reset_timeout
        self.state = CircuitState.CLOSED
        self.failures = 0
        self.last_failure_time = 0.0

    async def execute(self, fn: Callable[[], Any]) -> Any:
        if self.state == CircuitState.OPEN:
            if time.time() - self.last_failure_time > self.reset_timeout:
                self.state = CircuitState.HALF_OPEN
                logger.info(f"[{self.name}] Circuit HALF_OPEN: Probing service...")
            else:
                raise CircuitOpenError(f"[{self.name}] Circuit OPEN: Request blocked.")

        try:
            result = await fn()
            self._on_success()
            return result
        except Exception as e:
            self._on_failure()
            raise e

    def _on_success(self):
        if self.state == CircuitState.HALF_OPEN:
            logger.info(f"[{self.name}] Circuit CLOSED: Service recovered.")
        self.failures = 0
        self.state = CircuitState.CLOSED

    def _on_failure(self):
        self.failures += 1
        self.last_failure_time = time.time()
        if self.state == CircuitState.HALF_OPEN or self.failures >= self.failure_threshold:
            self.state = CircuitState.OPEN
            logger.error(f"[{self.name}] Circuit OPENED after {self.failures} failures.")

async def retry(
    fn: Callable[[], Any],
    retries: int = 3,
    delay: float = 1.0,
    decay: float = 2.0,
    jitter: float = 0.1,
    should_retry: Optional[Callable[[Exception], bool]] = None,
    on_retry: Optional[Callable[[Exception, int], None]] = None
) -> Any:
    start_time = time.time()
    max_timeout = 60.0

    for i in range(retries + 1):
        try:
            return await fn()
        except Exception as e:
            if should_retry and not should_retry(e):
                raise e
            if i == retries:
                raise e

            if on_retry:
                on_retry(e, i + 1)
            else:
                logger.warning(f"[Retry] Attempt {i + 1}/{retries} failed: {e}")

            if time.time() - start_time > max_timeout:
                raise RetryTimeoutError("Retry timeout exceeded")

            base_ms = delay * (decay ** i)
            jitter_ms = base_ms * (1 + (random.random() * jitter * 2 - jitter))
            await asyncio.sleep(jitter_ms)
    
    raise RuntimeError("Unreachable")

async def with_resilience(
    fn: Callable[[], Any],
    breaker: CircuitBreaker,
    retries: int = 3,
    delay: float = 1.0,
    should_retry: Optional[Callable[[Exception], bool]] = None
) -> Any:
    """Combines Retry and Circuit Breaker patterns."""
    return await breaker.execute(lambda: retry(fn, retries=retries, delay=delay, should_retry=should_retry))
