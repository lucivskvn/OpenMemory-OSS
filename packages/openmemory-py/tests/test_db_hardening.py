import pytest
import asyncio
import os
from openmemory.core.db import db, Queries  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.core.config import OpenMemoryConfig, load_config  # type: ignore[import-untyped]  # type: ignore[import-untyped]
import pytest_asyncio  # type: ignore[import-untyped]
  # type: ignore[import-untyped]

# Re-use the existing db fixture logic or define a fresh one for hardening tests
@pytest_asyncio.fixture
async def test_db():
    # Use an in-memory DB for speed and isolation
    test_url = "sqlite:///:memory:"
    
    # Backup original
    orig_url = db._current_url
    
    # Connect to test DB
    db.conn = None # Force reconnect
    # We need to hack the env/config temporarily
    from openmemory.core.config import env  # type: ignore[import-untyped]
    orig_env_url = env.db_url
    env.db_url = test_url
    
    db.connect(force=True)
    db.init_schema()
    
    yield db
    
    # Teardown
    await db.disconnect()
    env.db_url = orig_env_url
    # Don't necessarily reconnect original here, just leave clean state

@pytest.mark.asyncio
async def test_safe_config_validation():
    """Test that configuration rejects unsafe SQL identifiers if we implement strict validation."""
    # This assumes we add validation to the Config class or a validator
    from pydantic import ValidationError
    
    with pytest.raises(ValidationError):
        # validation should fail for weird characters in table names
        OpenMemoryConfig(db_url="sqlite:///:memory:", pg_table="drop table students;")

@pytest.mark.asyncio
async def test_deletion_consistency(test_db):
    """Verify that deleting a memory removes all traces (vectors, waypoints, etc)."""
    q = Queries()
    mid = "mem-delete-test"
    
    # 1. Insert Memory
    await q.ins_mem(id=mid, content="To be deleted", primary_sector="episodic", user_id="user-1")
    
    # 2. Insert Vector
    await test_db.async_execute(f"INSERT INTO {q.tables['vectors']} (id, sector, v, dim) VALUES (?, ?, ?, ?)", 
                               (mid, "episodic", b'\x00'*4, 1))
                               
    # 3. Insert Waypoint
    mid2 = "mem-neighbor"
    await q.ins_mem(id=mid2, content="Neighbor", primary_sector="episodic", user_id="user-1")
    await q.ins_waypoint(mid, mid2, "user-1", 0.9, 100, 100)
    
    # Verify existence
    assert await q.get_mem(mid) is not None
    assert await test_db.async_fetchone(f"SELECT * FROM {q.tables['vectors']} WHERE id=?", (mid,)) is not None
    assert await q.get_waypoint(mid, mid2) is not None
    
    # 4. Execute Full Deletion
    await q.del_mem(mid, user_id="user-1")
    
    # 5. Verify Absence
    assert await q.get_mem(mid) is None
    assert await test_db.async_fetchone(f"SELECT * FROM {q.tables['vectors']} WHERE id=?", (mid,)) is None, "Vector should be gone"
    assert await q.get_waypoint(mid, mid2) is None, "Waypoint source should be gone"
    
    # Check reverse waypoint (if mid was dst)
    await q.ins_mem(id=mid, content="To be deleted 2", primary_sector="episodic", user_id="user-1")
    await q.ins_waypoint(mid2, mid, "user-1", 0.9, 100, 100)
    await q.del_mem(mid, user_id="user-1")
    assert await q.get_waypoint(mid2, mid) is None, "Waypoint dest should be gone"

@pytest.mark.asyncio
async def test_transaction_rollback(test_db):
    """Ensure exceptions trigger rollback."""
    
    # Initial state
    await test_db.async_execute("CREATE TABLE IF NOT EXISTS test_tx (id INTEGER PRIMARY KEY)")
    await test_db.async_execute("DELETE FROM test_tx")
    await test_db.async_execute("INSERT INTO test_tx (id) VALUES (1)")
    
    try:
        async with test_db.transaction():
            await test_db.async_execute("INSERT INTO test_tx (id) VALUES (2)")
            raise RuntimeError("Force Rollback")
    except RuntimeError:
        pass
        
    rows = await test_db.async_fetchall("SELECT * FROM test_tx")
    ids = [r['id'] for r in rows]
    
    assert 1 in ids
    assert 2 not in ids, "Transaction should have rolled back ID 2"
