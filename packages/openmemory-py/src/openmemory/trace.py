from typing import List, Dict, Any, Optional
import contextvars
import uuid
import logging
import re
from .main import Memory

logger = logging.getLogger("trace")

# W3C Trace Context ContextVars
# Use None as default to avoid mutable shared state
trace_context = contextvars.ContextVar("trace_context", default=None)

class Tracer:
    def __init__(self, mem: "Memory"):
        self.mem = mem

    @staticmethod
    def get_current_trace_id() -> str:
        ctx = trace_context.get()
        if ctx is None:
            return str(uuid.uuid4())
        return ctx.get("trace_id", str(uuid.uuid4()))

    async def trace(self, query: str, user_id: str = None) -> Dict[str, Any]:
        """
        Explainable retrieval with trace propagation support.
        """
        current_trace_id = self.get_current_trace_id()
        logger.info(f"Tracing query: {query} [trace_id={current_trace_id}]")

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
            "trace_id": current_trace_id,
            "results": explanation
        }

def inject_trace_middleware(app):
    """
    FastAPI middleware to extract W3C Trace Context (traceparent, tracestate)
    """
    from fastapi import Request

    @app.middleware("http")
    async def trace_propagation_middleware(request: Request, call_next):
        traceparent = request.headers.get("traceparent")
        tracestate = request.headers.get("tracestate")

        trace_id = str(uuid.uuid4()).replace("-", "")

        # Validate traceparent: 00-traceid-parentid-flags
        # traceid must be 32 lowercase hex characters
        if traceparent:
            parts = traceparent.split("-")
            if len(parts) >= 2:
                inbound_trace_id = parts[1]
                if re.fullmatch(r"[0-9a-f]{32}", inbound_trace_id):
                    trace_id = inbound_trace_id

        token = trace_context.set({
            "trace_id": trace_id,
            "traceparent": traceparent,
            "tracestate": tracestate
        })

        try:
            response = await call_next(request)
            response.headers["x-openmemory-trace-id"] = trace_id
            return response
        finally:
            trace_context.reset(token)
