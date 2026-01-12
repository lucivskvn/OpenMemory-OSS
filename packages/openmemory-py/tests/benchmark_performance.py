import asyncio
import time
import uuid
from openmemory.main import Memory  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.core.db import db, q  # type: ignore[import-untyped]  # type: ignore[import-untyped]

async def benchmark():
    client = Memory()
    user_id = f"bench_{uuid.uuid4().hex[:8]}"
    count = 1000
    
    print(f"\n[Bench] Initializing benchmark for {count} items...")
    
    # Batch ingestion
    items = []
    for i in range(count):
        items.append({
            "content": f"Bulk data point {i} - {uuid.uuid4().hex} information about deep dive performance.",
            "tags": ["bench", f"layer_{i % 10}"],
            "metadata": {"val": i}
        })
    
    t0 = time.time()
    # Using batches of 100 for stability
    for chunk in [items[i:i + 100] for i in range(0, len(items), 100)]:
        await client.add_batch(chunk, user_id=user_id)
    t1 = time.time()
    
    dur_ingest = (t1 - t0) * 1000
    print(f"[Bench] Ingested {count} items in {dur_ingest:.1f}ms ({(dur_ingest/count):.1f}ms/item)")
    
    # 2. Search Performance (Fusion + Decay + Expansion)
    print(f"[Bench] Testing search performance on {count} items dataset...")
    t2 = time.time()
    results = await client.search("performance deep dive", user_id=user_id, limit=50)
    t3 = time.time()
    
    dur_search = (t3 - t2) * 1000
    print(f"[Bench] Search (k=50) took {dur_search:.1f}ms")
    
    # 3. Expansion Performance (Graph Traversal)
    # Create some waypoints first
    print(f"[Bench] Creating waypoints and testing expansion...")
    ids = [r.id for r in results[:10]]
    now = int(time.time() * 1000)
    async with db.transaction():
        for i in range(len(ids) - 1):
            await db.async_execute(
                f"INSERT OR REPLACE INTO {q.tables['waypoints']}(src_id, dst_id, user_id, weight, created_at, updated_at) VALUES (?,?,?,?,?,?)",
                (ids[i], ids[i+1], user_id, 0.9, now, now)
            )
            
    from openmemory.memory.hsg import expand_via_waypoints  # type: ignore[import-untyped]
    t4 = time.time()
    expanded = await expand_via_waypoints(ids, max_exp=100, user_id=user_id)
    t5 = time.time()
    
    dur_exp = (t5 - t4) * 1000
    print(f"[Bench] Graph expansion (Layer-BFS) took {dur_exp:.1f}ms for {len(expanded)} results")

    print("[Bench] Benchmark complete.")

if __name__ == "__main__":
    asyncio.run(benchmark())
