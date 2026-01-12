from fastapi import APIRouter, HTTPException, Depends, Body
from typing import Dict, Any, List, Optional
import time
from pydantic import BaseModel
from ...main import Memory
from ...core.db import q, db
from ..dependencies import verify_admin

router = APIRouter(tags=["users"])

# Models
class RegisterUserRequest(BaseModel):
    userId: str
    scope: str = "user"

@router.get("")
async def list_users(memory: Memory = Depends(lambda: Memory())):
    """List all active users."""
    users = await memory.list_users()
    return {"users": users}

@router.get("/keys", dependencies=[Depends(verify_admin)])
async def list_api_keys():
    """List API keys (Admin)."""
    rows = await q.list_api_keys()
    keys = [dict(r) for r in rows]
    return {"keys": keys}

@router.post("/register", dependencies=[Depends(verify_admin)])
async def register_user(req: RegisterUserRequest, memory: Memory = Depends(lambda: Memory())):
    """Register a new user (Admin)."""
    # Check if user exists?
    # This might require a 'users' table or just an API key gen.
    # In Local OpenMemory, users are implicit by memory ownership.
    # But we can generate an API key.
    import secrets
    import hashlib
    
    api_key = f"sk-om-{secrets.token_hex(16)}"
    key_hash = hashlib.sha256(api_key.encode()).hexdigest()
    
    # Insert into api_keys table
    await db.async_execute(
        "INSERT INTO api_keys (key_hash, user_id, role, note, created_at) VALUES (?, ?, ?, ?, ?)",
        (key_hash, req.userId, req.scope, "Generated via API", int(time.time() * 1000))
    )
    
    return {
        "success": True,
        "apiKey": api_key,
        "userId": req.userId,
        "role": req.scope,
        "note": "Generated via API"
    }

@router.delete("/keys/{prefix}", dependencies=[Depends(verify_admin)])
async def revoke_key(prefix: str):
    """
    Revoke API key by prefix (Admin).
    We can't hash a prefix to find the key. 
    We must iterate or query if we stored prefixes (we didn't).
    CRITICAL: We can only revoke by user_id or if we add metadata.
    However, for security, let's allow revoking by user_id if prefix matches 'user-{uid}'.
    
    Actually, we should just allow revoking by User ID given our schema.
    Or, since we don't store the prefix, we can't support this endpoint as defined.
    
    Let's change it to revoke by user_id for now as it's deterministic.
    """
    # Since we can't match prefix to hash, we will modify this to revoke by user_id 
    # or fail with not implemented for prefix.
    # But wait, we can just delete from api_keys where user_id = prefix? 
    # No, that's confusing.
    
    # Alternative: The user provides the full key to revoke? No, that's secrets management.
    
    # We will implement "Revoke all keys for user".
    try:
        # Currently treating prefix as user_id for utility
        target_user = prefix
        await db.async_execute(
            "UPDATE api_keys SET status='revoked' WHERE user_id=?", 
            (target_user,)
        )
        return {"success": True, "revoked_for_user": target_user}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{user_id}")
async def get_user(user_id: str):
    """Get user profile stub."""
    return {"userId": user_id, "created_at": 0}

@router.get("/{user_id}/summary")
async def get_user_summary(user_id: str):
    """Get user summary."""
    # Logic should be in memory.user_summary
    from ...memory.user_summary import get_summary
    s = await get_summary(user_id)
    return s or {}

@router.post("/{user_id}/summary/regenerate")
async def regenerate_summary(user_id: str):
    """Regenerate user summary."""
    from ...memory.user_summary import start_user_summary_reflection
    res = await start_user_summary_reflection(user_id)
    return {"success": True, "summary": res}

@router.post("/summaries/regenerate-all", dependencies=[Depends(verify_admin)])
async def regenerate_all_summaries(memory: Memory = Depends(lambda: Memory())):
    """Regenerate all."""
    users = await memory.list_users()
    count = 0
    from ...memory.user_summary import start_user_summary_reflection
    for u in users:
        await start_user_summary_reflection(u)
        count += 1
    return {"ok": True, "updated": count}
