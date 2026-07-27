from fastapi import FastAPI, Request, status, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
import time
import logging
import re
from ..core.config import env
from .routes import memory, health, sources
from ..trace import inject_trace_middleware

logger = logging.getLogger("server")

def create_app() -> FastAPI:
    app = FastAPI(title="OpenMemory API", version="1.2.2")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    inject_trace_middleware(app)

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "type": f"https://openmemory.oss/errors/{exc.status_code}",
                "title": exc.detail if isinstance(exc.detail, str) else "An error occurred",
                "status": exc.status_code,
                "detail": str(exc.detail),
                "instance": request.url.path
            },
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError):
        # Using exc.errors() without arguments to ensure compatibility across Pydantic versions
        # as reported by static analysis.
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "type": "https://openmemory.oss/errors/validation-error",
                "title": "Validation Error",
                "status": 422,
                "detail": exc.errors(),
                "instance": request.url.path
            },
        )

    @app.exception_handler(Exception)
    async def generic_exception_handler(request: Request, exc: Exception):
        logger.exception("Unhandled error")
        return JSONResponse(
            status_code=500,
            content={
                "type": "https://openmemory.oss/errors/internal-server-error",
                "title": "Internal Server Error",
                "status": 500,
                "detail": "An unexpected error occurred on the server.",
                "instance": request.url.path
            },
        )

    @app.middleware("http")
    async def authenticate_api_request(request: Request, call_next):
        import os
        import hmac
        import hashlib

        path = request.url.path
        # Public endpoints
        if path in ["/health", "/sources/webhook/github", "/sources/webhook/notion"]:
            return await call_next(request)

        api_key_configured = env.api_key
        require_auth = os.getenv("OM_REQUIRE_AUTH", "false").lower() == "true" or os.getenv("NODE_ENV", "") == "production"
        dev_allow_no_auth = os.getenv("OM_DEV_ALLOW_NO_AUTH", "false").lower() == "true" and os.getenv("NODE_ENV", "") != "production"

        if not api_key_configured:
            if dev_allow_no_auth:
                request.state.tenant = "dev-no-auth"
                return await call_next(request)
            else:
                return JSONResponse(
                    status_code=503,
                    content={
                        "type": "https://openmemory.oss/errors/503",
                        "title": "Service Unavailable",
                        "status": 503,
                        "detail": "Server has no OM_API_KEY configured. Protected endpoints are unavailable.",
                        "instance": path
                    }
                )

        provided = None
        if "x-api-key" in request.headers:
            provided = request.headers["x-api-key"]
        elif "authorization" in request.headers:
            auth_header = request.headers["authorization"]
            if auth_header.startswith("Bearer "):
                provided = auth_header[7:]
            elif auth_header.startswith("ApiKey "):
                provided = auth_header[7:]

        if not provided:
            return JSONResponse(
                status_code=401,
                content={
                    "type": "https://openmemory.oss/errors/401",
                    "title": "Unauthorized",
                    "status": 401,
                    "detail": "API key required",
                    "instance": path
                }
            )

        provided_hash = hashlib.sha256(provided.encode("utf-8")).digest()
        expected_hash = hashlib.sha256(api_key_configured.encode("utf-8")).digest()

        if not hmac.compare_digest(provided_hash, expected_hash):
            return JSONResponse(
                status_code=403,
                content={
                    "type": "https://openmemory.oss/errors/403",
                    "title": "Forbidden",
                    "status": 403,
                    "detail": "invalid_api_key",
                    "instance": path
                }
            )

        tenant = hashlib.sha256(provided.encode("utf-8")).hexdigest()[:16]
        request.state.tenant = tenant

        return await call_next(request)

    @app.middleware("http")
    async def log_requests(request: Request, call_next):
        start = time.time()
        # Sanitize path and method to prevent log forging
        path = re.sub(r"[\r\n]", "", request.url.path)
        method = re.sub(r"[\r\n]", "", request.method)
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            return response
        finally:
            process_time = (time.time() - start) * 1000
            logger.info(f"{method} {path} - {status_code} ({process_time:.2f}ms)")

    app.include_router(health.router)
    app.include_router(memory.router, prefix="/memory", tags=["memory"])
    app.include_router(sources.router)

    @app.on_event("startup")
    async def startup():
        logger.info(f"OpenMemory Server running on port {env.port}")

    return app
