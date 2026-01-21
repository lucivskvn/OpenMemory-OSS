import hashlib
import time
from typing import Optional
from fastapi import Security, HTTPException, Request, Depends
from fastapi.security.api_key import APIKeyHeader
from starlette.status import HTTP_403_FORBIDDEN
from ..core.config import env
from ..core.db import q, db

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

async def get_current_user_id(
    request: Request,
    api_key_header: str = Security(api_key_header)
) -> str:
    """
    Validates API Key and returns the derived user_id.
    Sets request.state.user_id and request.state.role.
    """
    # 1. Extract token
    token = None
    if api_key_header:
        token = api_key_header
    else:
        auth_header = request.headers.get("Authorization") if request else None
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header.split(" ")[1]

    if not token:
         # Fallback for local-only or anonymous modes
         request.state.user_id = "anonymous"
         request.state.role = "user"
         return "anonymous"

    # 2. Master Key Check
    if env.server_api_key:
        import hmac
        # DEBUG PRINT
        # print(f"DEBUG AUTH: token={token!r}, env_key={env.server_api_key!r}")
        # Use timing-safe comparison for the master key
        if hmac.compare_digest(token, env.server_api_key):
            request.state.user_id = "default-user"
            request.state.role = "admin"
            return "default-user"

    # 3. Database Lookup
    h = hashlib.sha256(token.encode()).hexdigest()
    try:
        key_exists = await q.get_api_key(h)
        if key_exists:
            # Check status? (active/revoked)
            if key_exists.get("status") == "revoked":
                raise HTTPException(status_code=403, detail="API Key revoked")

            # Update last_used
            # We skip commit for performance, or do it periodically?
            # For now, let's keep it simple.

            uid = key_exists["user_id"]
            request.state.user_id = uid
            request.state.role = key_exists.get("role", "user")
            return uid
    except Exception as e:
        logger = getattr(request.app.state, "logger", None)
        if logger: logger.error(f"Auth DB lookup failed: {e}")

    # 4. Fail Closed (If not master key and not in DB, reject)
    # Previous dev mode fallback removed for security parity with JS SDK.
    pass

    raise HTTPException(
        status_code=HTTP_403_FORBIDDEN, detail="Invalid API Key"
    )


def resolve_user(auth_user: str, target_user: Optional[str] = None) -> str:
    """
    Resolve effective user ID based on authentication status and requested target.
    Logic:
    - If auth_user is Admin ('default-user'), allow impersonation (target_user).
    - If auth_user is Anonymous, allow impersonation (target_user).
    - If auth_user is a hashed ID (standard user), FORCE auth_user.
    """
    if auth_user == "default-user":
        return target_user or "default-user"
    if auth_user == "anonymous":
        return target_user or "anonymous"
    return auth_user

def verify_admin(request: Request, user_id: str = Depends(get_current_user_id)):
    """
    Verify if the request has admin privileges.
    Ensures authentication runs first via dependency.
    """
    # Check if request state has user info (set by dependency)
    user_id = getattr(request.state, "user_id", None)  # type: ignore[arg-type]
    role = getattr(request.state, "role", "user")  # type: ignore[arg-type]

    # Global admin key bypass
    if user_id == "default-user":
        return

    # Check role
    if role == "admin":
        return

    raise HTTPException(status_code=403, detail="Admin privileges required")
