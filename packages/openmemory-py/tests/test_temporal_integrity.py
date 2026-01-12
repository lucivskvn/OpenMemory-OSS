import asyncio
import pytest
import time
from openmemory.temporal_graph.store import insert_fact, invalidate_fact, insert_edge  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.temporal_graph.query import query_facts_at_time, get_current_fact  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.core.db import db, q  # type: ignore[import-untyped]  # type: ignore[import-untyped]

@pytest.mark.asyncio
async def test_temporal_fact_invalidation_integrity():
    user_id = "test_user_temporal"
    subject = "AI_Model_X"
    predicate = "version"
    
    # 1. Insert v1
    v1_id = await insert_fact(subject, predicate, "1.0", user_id=user_id)
    
    # 2. Insert v2 at t+100ms
    time.sleep(0.1)
    v2_id = await insert_fact(subject, predicate, "2.0", user_id=user_id)
    
    # 3. Verify v1 is invalidated
    fact1 = await db.async_fetchone(f"SELECT valid_to FROM {q.tables['temporal_facts']} WHERE id=?", (v1_id,))
    assert fact1["valid_to"] is not None
    
    # 4. Verify v2 is current
    current = await get_current_fact(subject, predicate, user_id=user_id)
    assert current["object"] == "2.0"
    assert current["valid_to"] is None

@pytest.mark.asyncio
async def test_multi_tenant_temporal_isolation():
    sub = "Secret_Project"
    pred = "status"
    
    # User A data
    await insert_fact(sub, pred, "A_Active", user_id="user_a")
    
    # User B data
    await insert_fact(sub, pred, "B_Active", user_id="user_b")
    
    # Query as User A
    facts_a = await query_facts_at_time(subject=sub, user_id="user_a")
    assert len(facts_a) == 1
    assert facts_a[0]["object"] == "A_Active"
    
    # Query as User B
    facts_b = await query_facts_at_time(subject=sub, user_id="user_b")
    assert len(facts_b) == 1
    assert facts_b[0]["object"] == "B_Active"

if __name__ == "__main__":
    asyncio.run(test_temporal_fact_invalidation_integrity())
    asyncio.run(test_multi_tenant_temporal_isolation())
