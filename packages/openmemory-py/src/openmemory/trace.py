from typing import List, Dict, Any, Optional
import contextvars
import uuid
import logging
from .main import Memory

logger = logging.getLogger("trace")

# W3C Trace Context ContextVars
trace_context = contextvars.ContextVar("trace_context", default={})

class Tracer:
    def __init__(self, mem: "Memory"):
        self.mem = mem

    @staticmethod
    def get_current_trace_id() -> str:
        ctx = trace_context.get()
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

        # traceparent format: 00-traceid-parentid-flags
        trace_id = str(uuid.uuid4()).replace("-", "")
        if traceparent:
            parts = traceparent.split("-")
            if len(parts) >= 2:
                trace_id = parts[1]

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
