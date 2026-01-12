import os
import pytest
import asyncio
import time

# Set env vars BEFORE importing anything from openmemory
os.environ["OM_ENCRYPTION_ENABLED"] = "true"
os.environ["OM_ENCRYPTION_KEY"] = "original-secret-key-12345"
os.environ["DATABASE_URL"] = "sqlite:///:memory:"

from openmemory.main import Memory
from openmemory.core.config import env
from openmemory.core.db import db, q
import openmemory.core.security as sec

@pytest.mark.asyncio
async def test_key_rotation():
    # Force reload config to pick up env changes
    env.update_config(
        encryption_enabled=True,
        encryption_key="original-secret-key-12345",
        database_url="sqlite:///:memory:"
    )
    
    # Force DB reconnect to :memory:
    db.conn = None
    db._current_url = None
    db.connect(force=True)
    
    # Reset security singleton to pick up new config
    sec._instance = None
    provider = sec.get_encryption()
    assert provider.enabled is True
    
    mem = Memory()
    
    # 1. Add some data with original key (Distinct enough to avoid dedup)
    await mem.add("This is unique memory Alpha for testing rotation.", user_id="user1")
    await mem.add("Completely different content Beta for verifying key rotation.", user_id="user1")
    
    # Verify it's encrypted in DB
    rows = await q.all_mem(user_id="user1")
    assert len(rows) == 2
    assert rows[0]["content"].startswith("v1:")
    
    # 2. Change key and add old to secondary
    old_key = "original-secret-key-12345"
    new_key = "new-rotated-secret-key-67890"
    
    env.encryption_key = new_key
    env.encryption_secondary_keys = [old_key]
    
    # Reset security singleton again
    sec._instance = None
    provider = sec.get_encryption()
    assert provider.secret == new_key
    assert old_key in provider.secondary_secrets
    
    # 3. Verify we can still read (Fallback decryption)
    m1 = await mem.get(rows[0]["id"], user_id="user1")
    assert "unique memory Alpha" in m1.content or "different content Beta" in m1.content
    
    # 4. Trigger rotation
    rot_res = await mem.rotate_key(user_id="user1")
    assert rot_res["success"] is True
    assert rot_res["rotated_count"] == 2
    
    # 5. Remove old key and verify it still works (Now with new key)
    env.encryption_secondary_keys = []
    sec._instance = None
    provider = sec.get_encryption()
    assert provider.secondary_secrets == []
    
    m2 = await mem.get(rows[0]["id"], user_id="user1")
    assert "unique memory Alpha" in m2.content or "different content Beta" in m2.content
    
    # Verify DB content changed (different IV/CT)
    rows_after = await q.all_mem(user_id="user1")
    assert rows_after[0]["content"] != rows[0]["content"]
    assert rows_after[0]["content"].startswith("v1:")
    
    print("\n✅ Key rotation verified successfully.")

if __name__ == "__main__":
    asyncio.run(test_key_rotation())
