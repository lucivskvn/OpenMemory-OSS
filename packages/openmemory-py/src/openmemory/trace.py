import asyncio
import uuid
import time
import logging
from contextvars import ContextVar
from typing import Dict, Any, Optional, List, Callable
from dataclasses import dataclass, field
from functools import wraps

# --- Global Context ---

@dataclass
class SpanContext:
    trace_id: str
    span_id: str
    parent_id: Optional[str]
    user_id: Optional[str]
    name: str
    start_time: int
    metadata: Dict[str, Any] = field(default_factory=dict)
    
_current_span: ContextVar[Optional["Span"]] = ContextVar("current_span", default=None)

# --- Span Class ---

class Span:
    def __init__(self, name: str, user_id: Optional[str] = None, parent: Optional["Span"] = None):
        self.id = str(uuid.uuid4())
        self.trace_id = parent.trace_id if parent else str(uuid.uuid4())
        self.parent_id = parent.id if parent else None
        self.user_id = user_id or (parent.user_id if parent else "anonymous")
        self.name = name
        self.start_time = int(time.time() * 1000)
        self.end_time: Optional[int] = None
        self.metadata: Dict[str, Any] = {}
        self.events: List[Dict[str, Any]] = []
        self.status: str = "ok"
        self._parent = parent

    def set_attribute(self, key: str, value: Any):
        self.metadata[key] = value

    def add_event(self, name: str, attributes: Optional[Dict[str, Any]] = None):
        self.events.append({
            "name": name,
            "ts": int(time.time() * 1000),
            "attributes": attributes or {}
        })

    def end(self):
        self.end_time = int(time.time() * 1000)
        # In a real system, we would export the span here
        pass
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "trace_id": self.trace_id,
            "span_id": self.id,
            "parent_id": self.parent_id,
            "user_id": self.user_id,
            "name": self.name,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "duration": (self.end_time - self.start_time) if self.end_time else None,
            "metadata": self.metadata,
            "events": self.events,
            "status": self.status
        }

    def __enter__(self):
        self.token = _current_span.set(self)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type:
            self.status = "error"
            self.set_attribute("error.message", str(exc_val))
        self.end()
        _current_span.reset(self.token)

    async def __aenter__(self):
        self.token = _current_span.set(self)
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if exc_type:
            self.status = "error"
            self.set_attribute("error.message", str(exc_val))
        self.end()
        _current_span.reset(self.token)

# --- Tracer ---

class Tracer:
    """
    OpenMemory Tracer.
    Provides distributed tracing capabilities and explainable query tools.
    """
    def __init__(self, mem: Any = None):
        self.mem = mem # Optional reference to memory system for explainability

    @staticmethod
    def start_span(name: str, user_id: Optional[str] = None) -> Span:
        """Start a new span, inheriting context if available."""
        parent = _current_span.get()
        return Span(name, user_id, parent)

    @staticmethod
    def current_span() -> Optional[Span]:
        """Get the current active span."""
        return _current_span.get()

    @staticmethod
    def inject_context(headers: Dict[str, str]):
        """Inject current trace context into headers."""
        span = _current_span.get()
        if span:
            headers["x-trace-id"] = span.trace_id
            headers["x-span-id"] = span.id
            if span.user_id:
                headers["x-user-id"] = span.user_id

    async def explain_query(self, query: str, user_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Explainable retrieval (Legacy 'trace' method).
        """
        if not self.mem:
            raise RuntimeError("Tracer not initialized with Memory instance")

        with self.start_span("explain_query", user_id=user_id) as span:
            span.set_attribute("query", query)
            results = await self.mem.search(query, user_id=user_id, debug=True)
            
            explanation = []
            for r in results:
                debug = r.get("_debug", {})
                explanation.append({
                    "id": r["id"],
                    "content_preview": r["content"][:50],
                    "score_breakdown": debug
                })
            
            return {
                "query": query,
                "user_id": user_id,
                "results": explanation,
                "trace_id": span.trace_id
            }

# --- Decorator ---

def traced(name: Optional[str] = None):
    def decorator(func: Callable):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            span_name = name or func.__qualname__
            # Try to find user_id in kwargs
            uid = kwargs.get("user_id")
            with Tracer.start_span(span_name, user_id=uid) as span:
                return await func(*args, **kwargs)
        return wrapper
    return decorator
