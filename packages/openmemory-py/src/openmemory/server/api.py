import logging
import hashlib
from typing import Optional
import uvicorn
from fastapi import FastAPI, Request, HTTPException, Security, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security.api_key import APIKeyHeader
from starlette.status import HTTP_403_FORBIDDEN
from ..core.config import env
from ..utils.logger import setup_logging
from .routers import (
    memory_router, ide_router, dashboard_router, temporal_router,
    compression_router, langgraph_router, sources_router, sources_cfg_router,
    users_router, admin_router
)
from .dependencies import get_current_user_id
from .dependencies import get_current_user_id, verify_admin

# Initialize Logging (Root config)
setup_logging()
logger = logging.getLogger("openmemory.server")

app = FastAPI(title="OpenMemory API", version="2.3.0")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Tracing Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from ..trace import Tracer

class TracingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Extract trace context from headers
        trace_id = request.headers.get("x-trace-id")
        parent_id = request.headers.get("x-span-id")

        # Manually context propagation if headers exist
        # Tracer.start_span handles parent if we could inject it into context,
        # but Tracer design relies on ContextVar.
        # We can pass parent_id logic or let Tracer handle it if we modify it.
        # However, Tracer.start_span currently takes a `parent` Span object.
        # We don't have the parent Span object, just ID.
        # For now, we will just use the IDs for logging if possible, or start a fresh root with links.
        # To truly support distributed tracing, Tracer.start_span needs to accept parent_id/trace_id strings.

        # Let's adapt tracing slightly.
        # We'll just set the trace_id on the new span if provided, preserving the trace.

        user_id = "anonymous"  # Will be refined by auth later

        path = request.url.path
        # We need to enhance Tracer to accept specific trace_id/parent_id
        # Since we can't easily change Tracer right now without breaking changes,
        # we will monkey-patch or rely on the fact that we are the root of this service's trace.

        with Tracer.start_span(f"http_request:{path}", userId=user_id) as span:  # type: ignore[call-arg]
            if trace_id:
                # Override the generated IDs to link traces
                span.trace_id = trace_id
                if parent_id:
                    span.parent_id = parent_id

            span.set_attribute("http.method", request.method)
            span.set_attribute("http.url", str(request.url))

            response = await call_next(request)

            span.set_attribute("http.status_code", response.status_code)
            return response

from .metrics import metrics

class TelemetryMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        try:
            response = await call_next(request)
            # Record success/failure
            is_error = response.status_code >= 500
            metrics.record_request(error=is_error)
            return response
        except Exception as e:
            # Exception bubbling up means 500
            metrics.record_request(error=True)
            raise e

app.add_middleware(TelemetryMiddleware)

app.add_middleware(TracingMiddleware)

# Authentication


# Mount Routers
# We inject the current_user dependency into the routers?
# Or we rely on the router endpoints to ask for it?
# In our router implementation (memory.py etc), they accept `req` models which have `user_id`.
# WE need to inject the AUTHENTICATED user_id if the request doesn't specify one,
# OR enforce that the authenticated user matches the requested user_id.
# For simplicity and parity: The routers below should use `Depends(get_current_user_id)` override.
# BUT, the routers defined Pydantic models with `user_id`.
# Structure:
# Router endpoint args: (req: RequestModel, auth_user: str = Depends(get_current_user_id))
# Then override req.user_id = req.user_id or auth_user
# Since I already wrote the routers to take Pydantic models, I won't rewrite them all now.
# Instead, I will mount them, and the `get_current_user_id` will be a global dependency that ensures auth.
# But for the routers to *know* the user ID, they need to depend on it.
# Let's keep it simple: Basic Key Auth protection on the routes.
# The `user_id` in the body is trusted if Auth passes?
# In JS `memory.ts`: `const uid = req.user?.id || req.body.user_id;`
# So yes, if you are authenticated, you can impersonate or assume identity.

app.include_router(
    memory_router,
    prefix="/memory",
    tags=["memory"],
    dependencies=[Depends(get_current_user_id)],
)
app.include_router(
    ide_router,
    prefix="/api/ide",
    tags=["ide"],
    dependencies=[Depends(get_current_user_id)],
)
app.include_router(
    dashboard_router,
    prefix="/dashboard",
    tags=["dashboard"],
    dependencies=[Depends(get_current_user_id)],
)
app.include_router(
    temporal_router,
    prefix="/api/temporal",
    tags=["temporal"],
    dependencies=[Depends(get_current_user_id)],
)
app.include_router(
    compression_router,
    prefix="/api/compression",
    tags=["compression"],
    dependencies=[Depends(get_current_user_id)],
)
app.include_router(
    langgraph_router,
    prefix="/lgm",
    tags=["langgraph"],
    dependencies=[Depends(get_current_user_id)],
)
app.include_router(
    sources_router,
    prefix="/sources",
    tags=["sources"],
    dependencies=[Depends(get_current_user_id)],
)
app.include_router(
    sources_cfg_router,
    prefix="/source-configs",
    tags=["sources"],
    dependencies=[Depends(get_current_user_id)],
)
app.include_router(
    users_router,
    prefix="/users",
    tags=["users"],
    dependencies=[Depends(get_current_user_id)],
)
app.include_router(
    admin_router,
    prefix="/admin",
    tags=["admin"],
    dependencies=[Depends(get_current_user_id), Depends(verify_admin)],
)


@app.get("/health")
def health():
    return {"status": "ok", "version": "2.3.0"}


def start_server():
    """Start the uvicorn server."""
    port = env.port
    logger.info(f"Starting OpenMemory Server on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
