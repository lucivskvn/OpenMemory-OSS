"""
base connector class for openmemory data sources - production grade

features:
- custom exception hierarchy
- logging
- retry logic with exponential backoff
- rate limiting
- pydantic models
- async execution wrapper
"""
from typing import Any, List, Dict, Optional, Callable, TypeVar
from abc import ABC, abstractmethod
import asyncio
import time
import os
import logging
import functools
from pydantic import BaseModel, Field, ConfigDict

logger = logging.getLogger("openmemory.connectors")

# -- exceptions --

class SourceError(Exception):
    """Base exception for source errors"""
    def __init__(
        self, msg: str, source: Optional[str] = None, cause: Optional[Exception] = None, retryable: bool = False
    ):
        self.source = source
        self.cause = cause
        self.retryable = retryable
        super().__init__(f"[{source}] {msg}" if source else msg)

ConnectorError = SourceError


class SourceAuthError(SourceError):
    """Authentication failure"""
    pass

class SourceConfigError(SourceError):
    """Configuration error"""
    pass

class SourceRateLimitError(SourceError):
    """Rate limit exceeded"""
    def __init__(
        self,
        msg: str,
        retry_after: Optional[float] = None,
        source: Optional[str] = None,
    ):
        self.retry_after = retry_after
        super().__init__(msg, source)


class SourceFetchError(SourceError):
    """Failed to fetch data"""
    pass

# -- types --

class SourceItem(BaseModel):
    """Item from a source"""
    id: str
    name: str
    type: str  # file, dir, issue, etc
    path: Optional[str] = None
    size: Optional[int] = 0
    sha: Optional[str] = None
    updated_at: Optional[int] = None
    metadata: Optional[Dict[str, Any]] = None
    model_config = ConfigDict(populate_by_name=True)

class SourceContent(BaseModel):
    """Content fetched from source"""
    id: str
    name: str
    type: str
    text: str
    data: Optional[Any] = None
    metadata: Dict[str, Any] = Field(default_factory=dict, alias="meta")

    model_config = ConfigDict(populate_by_name=True)

T = TypeVar("T")

# -- rate limiter --

class RateLimiter:
    """Token bucket rate limiter"""

    def __init__(self, requests_per_second: float = 10):
        self.rps = requests_per_second
        self.tokens = requests_per_second
        self.last_update = time.time()

    async def acquire(self):
        now = time.time()
        elapsed = now - self.last_update
        self.tokens = min(self.rps, self.tokens + elapsed * self.rps)
        self.last_update = now

        if self.tokens < 1:
            wait_time = (1 - self.tokens) / self.rps
            await asyncio.sleep(wait_time)
            self.tokens = 0
        else:
            self.tokens -= 1

# -- retry helper --

async def with_retry(
    fn: Callable[..., Any],
    max_attempts: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 60.0
):
    """Execute fn with exponential backoff retry"""
    last_err: Optional[Exception] = None

    for attempt in range(max_attempts):
        try:
            val = fn()
            if asyncio.iscoroutine(val):
                return await val
            return val
        except SourceAuthError:
            raise  # don't retry auth errors
        except Exception as e:
            last_err = e

            if attempt < max_attempts - 1:
                if isinstance(e, SourceRateLimitError) and e.retry_after:
                    delay = e.retry_after
                else:
                    delay = min(base_delay * (2 ** attempt), max_delay)

                logger.warning(f"[retry] attempt {attempt + 1}/{max_attempts} failed: {e}, retrying in {delay}s")
                await asyncio.sleep(delay)

    if last_err:
        raise last_err
    raise RuntimeError("Max retries exceeded")

# -- base connector --

class BaseConnector(ABC):
    """base class for all connectors with production-grade features"""

    name: str = "base"

    def __init__(
        self,
        user_id: Optional[str] = None,
        max_retries: int = 3,
        requests_per_second: float = 10,
    ):
        self.user_id = user_id or "anonymous"
        self._connected = False
        self._max_retries = max_retries
        self._rate_limiter = RateLimiter(requests_per_second)

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self, **creds) -> bool:
        """authenticate with the service"""
        logger.info(f"[{self.name}] connecting...")
        try:
            result = await self._connect(**creds)  # type: ignore[attr-defined]
            self._connected = result
            if result:
                logger.info(f"[{self.name}] connected")
            return result
        except Exception as e:
            logger.error(f"[{self.name}] connection failed: {e}")
            raise SourceAuthError(str(e), self.name, e)

    async def disconnect(self):
        """disconnect from the service"""
        self._connected = False
        logger.info(f"[{self.name}] disconnected")

    async def list_items(self, **filters) -> List[SourceItem]:
        """list available items from the source with retry"""
        if not self._connected:
            await self.connect()

        await self._rate_limiter.acquire()

        try:
            items = await with_retry(
                lambda: self._list_items(**filters),  # type: ignore[attr-defined]
                self._max_retries,
            )
            logger.info(f"[{self.name}] found {len(items)} items")
            return items
        except Exception as e:
            raise SourceFetchError(str(e), self.name, e)

    async def fetch_item(self, item_id: str) -> SourceContent:
        """fetch a single item by id with retry"""
        if not self._connected:
            await self.connect()

        await self._rate_limiter.acquire()

        try:
            return await with_retry(
                lambda: self._fetch_item(item_id),  # type: ignore[attr-defined]
                self._max_retries,
            )
        except Exception as e:
            raise SourceFetchError(str(e), self.name, e)

    async def ingest_all(self, **filters) -> List[str]:  # type: ignore[return]
        """fetch and ingest all items matching filters with concurrency control"""
        from ..ops.ingest import ingest_document

        items = await self.list_items(**filters)

        logger.info(f"[{self.name}] ingesting {len(items)} items with parallel workers...")

        semaphore = asyncio.Semaphore(5) # limit concurrency

        async def _ingest_safe(item):
            async with semaphore:
                try:
                    content = await self.fetch_item(item.id)
                    result = await ingest_document(  # type: ignore[arg-type]
                        t=content.type,
                        data=content.data or content.text,
                        metadata={"source": self.name, **content.metadata},  # type: ignore[arg-type]
                        user_id=self.user_id,
                    )
                    return result["root_memory_id"]
                except Exception as e:
                    logger.warning(f"[{self.name}] failed to ingest {item.id}: {e}")
                    return None

        tasks = [_ingest_safe(item) for item in items]
        results = await asyncio.gather(*tasks)

        ids = [rid for rid in results if rid]
        error_count = len(items) - len(ids)

        logger.info(f"[{self.name}] ingested {len(ids)} items, {error_count} errors")
        return ids

    async def _run_blocking(self, func: Callable[..., T], *args, **kwargs) -> T:
        """Run a blocking function in a separate thread to avoid blocking the event loop"""
        loop = asyncio.get_running_loop()
        pfunc = functools.partial(func, *args, **kwargs)
        return await loop.run_in_executor(None, pfunc)

    def _get_env(self, key: str, default: Optional[str] = None) -> Optional[str]:
        """helper to get env var"""
        return os.environ.get(key, default)

    # abstract methods for subclasses
    @abstractmethod
    async def _connect(self, **creds) -> bool:
        """internal connect implementation"""
        pass

    @abstractmethod
    async def _list_items(self, **filters) -> List[SourceItem]:
        """internal list implementation"""
        pass

    @abstractmethod
    async def _fetch_item(self, item_id: str) -> SourceContent:
        """internal fetch implementation"""
        pass
