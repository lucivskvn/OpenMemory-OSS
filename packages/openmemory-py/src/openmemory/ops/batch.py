import json
import logging
from typing import List, Dict, Any, Optional
from ..core.db import db, q
from ..memory.hsg import add_hsg_memories

logger = logging.getLogger("openmemory")

async def delete_batch(ids: List[str], user_id: Optional[str] = None) -> int:
    """
    Delete multiple memories by ID (Bulk operation).
    """
    return await q.del_mems(ids, user_id=user_id)

async def update_batch(items: List[Dict[str, Any]], user_id: Optional[str] = None) -> int:
    """
    Update multiple memories with specific fields.
    Each item must contain 'id'.
    """
    if not items:
        return 0
    
    # Extract IDs for validation or filtering
    ids = [item['id'] for item in items if 'id' in item]
    if not ids:
        return 0
        
    return await q.upd_mems(items, user_id=user_id)
