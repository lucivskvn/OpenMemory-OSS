from .memory import router as memory_router
from .ide import router as ide_router
from .dashboard import router as dashboard_router
from .temporal import router as temporal_router
from .compression import router as compression_router
from .langgraph import router as langgraph_router
from .sources import router as sources_router, config_router as sources_cfg_router
from .users import router as users_router
from .admin import router as admin_router
from .system import router as system_router

__all__ = [
    "memory_router",
    "ide_router",
    "dashboard_router",
    "temporal_router",
    "compression_router",
    "langgraph_router",
    "sources_router",
    "sources_cfg_router",
    "users_router",
    "admin_router",
    "system_router",
]
