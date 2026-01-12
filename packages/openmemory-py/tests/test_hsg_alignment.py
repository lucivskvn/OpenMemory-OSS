import asyncio
import pytest
import time
import uuid
from unittest.mock import patch, MagicMock
from openmemory.memory.hsg import add_hsg_memory, add_hsg_memories, hsg_query, hsg_state  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.memory.hsg import add_hsg_memory, add_hsg_memories, hsg_query, hsg_state  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.core.db import db, q  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.ai.adapters import reset_adapter  # type: ignore[import-untyped]  # type: ignore[import-untyped]

@pytest.fixture(autouse=True)
async def cleanup_adapters():
    # Force cleanup of global state
    hsg_state.coact_buf = []
    hsg_state.cache = {}
    
    await db.disconnect()
    db._lock = None # Force regeneration
    db._tx_lock = None
    reset_adapter()
    
    yield
    
    await db.disconnect()
    db._lock = None
    db._tx_lock = None
    reset_adapter()
    hsg_state.coact_buf = []

@pytest.mark.asyncio
@patch("openmemory.memory.hsg.update_user_summary", new_callable=MagicMock)
@patch("openmemory.memory.hsg.trigger_coactivation_sync", new_callable=MagicMock)
async def test_ingestion_parity(mock_sync, mock_summary):
    # Test that batch and single ingestion produce equivalent cognitive state
    uid = f"parity_test_{uuid.uuid4().hex[:8]}"
    content_single = f"Unique single memory content {uuid.uuid4()}"
    content_batch = f"Unique batch memory content {uuid.uuid4()}"
    
    # 1. Single add
    res_single = await add_hsg_memory(content_single, user_id=uid)
    
    # 2. Batch add
    res_batch_list = await add_hsg_memories([{"content": content_batch}], user_id=uid)
    res_batch = res_batch_list[0]
    
    # 3. Verify Waypoints
    t = q.tables
    wp_single = await db.async_fetchall(f"SELECT * FROM {t['waypoints']} WHERE src_id=?", (res_single["id"],))
    wp_batch = await db.async_fetchall(f"SELECT * FROM {t['waypoints']} WHERE src_id=?", (res_batch["id"],))
    
    print(f"Single WPs: {len(wp_single)}")
    print(f"Batch WPs: {len(wp_batch)}")
    
    assert len(wp_single) > 0, "Single ingestion failed to create waypoints"
    assert len(wp_batch) > 0, "Batch ingestion failed to create waypoints"
    
    # 4. Verify Metadata
    mem_single = await q.get_mem(res_single["id"], uid)
    mem_batch = await q.get_mem(res_batch["id"], uid)
    
    # Check that 'meta' is present and valid
    assert mem_single["metadata"] is not None
    assert mem_batch["metadata"] is not None

@pytest.mark.asyncio
@patch("openmemory.memory.hsg.update_user_summary", new_callable=MagicMock)
@patch("openmemory.memory.hsg.trigger_coactivation_sync", new_callable=MagicMock)
async def test_query_multiplier_starvation(mock_sync, mock_summary):
    # Test that multiplier avoids starvation with temporal filters
    # Call await to satisfy async interface if needed, relying on MagicMock
    mock_summary.return_value = None 
    uid = f"starve_test_{uuid.uuid4().hex[:8]}"
    
    # Insert 50 memories, but only 1 is deep in the past
    now = int(time.time() * 1000)
    old_ts = now - (365 * 86400 * 1000) # 1 year ago
    
    # One OLD memory
    await add_hsg_memory("This is a very old memory about an ancient project.", user_id=uid, created_at_override=old_ts)
    
    # 49 NEW memories that are more semantically similar to the query but filtered out by time
    for i in range(200):
        await add_hsg_memory(f"Recent update {i} about current project progress.", user_id=uid)
    
    # Query for "ancient project" with temporal filter for more than 6 months ago
    six_months_ago = now - (180 * 86400 * 1000)
    
    # If k=5 and multiplier=1, we search 15. The old memory might be at rank 50 (too far).
    # With multiplier=5, we search 25. Still might miss if we have 49 semantically closer.
    # But wait, 49 are "Recent update...". "Ancient project" should be closer to "ancient project".
    # Let's make them even more semantically deceptive.
    
    # Better test: Query for "project"
    # The 49 recent ones match "project" perfectly. The 1 old one also matches "project".
    # If we only fetch 15 (k=5 * 3), we only see recent ones.
    # If we fetch 25 (k=5 * 5), we still might miss if we have 50.
    
    res = await hsg_query("project", k=5, f={"user_id": uid, "endTime": six_months_ago})
    
    assert len(res) > 0, "Query starvation: failed to find the old memory despite it being the only one passing the filter."
    assert res[0].content == "This is a very old memory about an ancient project."

if __name__ == "__main__":
    import asyncio
    async def run_tests():
        await test_ingestion_parity()
        await test_query_multiplier_starvation()
    asyncio.run(run_tests())
