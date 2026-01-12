import pytest
import asyncio
import time
import uuid
from openmemory.main import Memory  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.core.db import db  # type: ignore[import-untyped]  # type: ignore[import-untyped]

@pytest.mark.asyncio
async def test_batch_ingestion_performance():
    client = Memory()
    user_id = f"test_perf_{uuid.uuid4().hex[:8]}"
    
    # 1. Prepare 50 memories
    items = []
    for i in range(50):
        items.append({
            "content": f"Performance test memory item {i} with some unique content {uuid.uuid4().hex}",
            "tags": ["perf", "test", f"batch_{i // 10}"],
            "metadata": {"index": i, "batch_test": True}
        })
        
    print(f"\n[Perf] Starting batch ingestion of {len(items)} items for user {user_id}...")
    t0 = time.time()
    results = await client.add_batch(items, user_id=user_id)
    t1 = time.time()
    
    dur = (t1 - t0) * 1000
    print(f"[Perf] Batch ingestion completed in {dur:.1f}ms ({(dur/len(items)):.1f}ms per item)")
    
    assert len(results) == len(items)
    for r in results:
        assert "id" in r
        assert "sectors" in r

    # 2. Verify retrieval
    print(f"[Perf] Testing search performance...")
    t2 = time.time()
    search_res = await client.search("unique content", user_id=user_id, limit=20)
    t3 = time.time()
    
    dur_search = (t3 - t2) * 1000
    print(f"[Perf] Search (Top 20) completed in {dur_search:.1f}ms")
    
    assert len(search_res) > 0
    # Search should include fusion and decay checks which are now optimized
    
    # 3. Verify Cache effectiveness
    from openmemory.core.db import q  # type: ignore[import-untyped]
    print(f"[Perf] Testing cache hit for stats...")
    # First call to stats (populates cache for sectors etc if we used it there, 
    # but currently get_stats is not cached, only get_user/get_api_key)
    # Let's test get_user cache
    await q.get_user(user_id)
    t4 = time.time()
    await q.get_user(user_id)
    t5 = time.time()
    dur_cache = (t5 - t4) * 1000
    print(f"[Perf] Cached get_user lookup: {dur_cache:.4f}ms")
    assert dur_cache < 1.0 # Should be near-instant

    # 4. Clean up
    # We leave records for manual inspection if needed, or clean up via migration-based test runner
    pass

if __name__ == "__main__":
    asyncio.run(test_batch_ingestion_performance())
