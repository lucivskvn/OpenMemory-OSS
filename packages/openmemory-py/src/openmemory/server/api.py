from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
import time
import logging
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
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "type": "https://openmemory.oss/errors/validation-error",
                "title": "Validation Error",
                "status": 422,
                "detail": exc.errors(include_input=False, include_context=False),
                "instance": request.url.path
            },
        )

    @app.exception_handler(Exception)
    async def generic_exception_handler(request: Request, exc: Exception):
        logger.error(f"Unhandled error: {str(exc)}", exc_info=True)
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
    async def log_requests(request: Request, call_next):
        start = time.time()
        path = request.url.path.replace("\n", "").replace("\r", "")
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            return response
        finally:
            process_time = (time.time() - start) * 1000
            logger.info(f"{request.method} {path} - {status_code} ({process_time:.2f}ms)")

    app.include_router(health.router)
    app.include_router(memory.router, prefix="/memory", tags=["memory"])
    app.include_router(sources.router)

    @app.on_event("startup")
    async def startup():
        logger.info(f"OpenMemory Server running on port {env.port}")

    return app
