import pytest
from openmemory.core.db import db, q
from openmemory.memory.hsg import expand_via_waypoints

T_ALICE = "tenant-alice-py-wp"
T_BOB = "tenant-bob-py-wp"

@pytest.mark.asyncio
async def test_expand_via_waypoints_tenant_isolation():
    db.execute("DELETE FROM waypoints")
    db.commit()

    now = 1000
    mem_id = "node-py-1"

    db.execute("INSERT INTO waypoints(src_id, dst_id, user_id, weight, created_at, updated_at) VALUES (?,?,?,?,?,?)",
               (mem_id, "dst-alice", T_ALICE, 0.8, now, now))
    db.execute("INSERT INTO waypoints(src_id, dst_id, user_id, weight, created_at, updated_at) VALUES (?,?,?,?,?,?)",
               (mem_id, "dst-bob", T_BOB, 0.9, now, now))
    db.commit()

    # Expand for Alice only
    alice_exp = await expand_via_waypoints([mem_id], 10, user_id=T_ALICE)
    alice_ids = [e["id"] for e in alice_exp]
    assert "dst-alice" in alice_ids
    assert "dst-bob" not in alice_ids

    # Missing / None user_id fails closed (returns empty)
    none_exp = await expand_via_waypoints([mem_id], 10, user_id=None)
    assert none_exp == []

    # Empty user_id fails closed
    empty_exp = await expand_via_waypoints([mem_id], 10, user_id="")
    assert empty_exp == []

    # Whitespace user_id fails closed
    space_exp = await expand_via_waypoints([mem_id], 10, user_id="   ")
    assert space_exp == []

@pytest.mark.asyncio
async def test_db_queries_get_mem_and_waypoints_tenant_isolation():
    from openmemory.main import Memory
    db.execute("DELETE FROM memories")
    db.execute("DELETE FROM waypoints")
    db.commit()

    mid = "mem-tenant-test-1"
    now = 1000

    q.ins_mem(
        id=mid,
        user_id=T_ALICE,
        content="Alice secret memory",
        primary_sector="semantic",
        created_at=now,
        updated_at=now,
        last_seen_at=now
    )

    db.execute("INSERT INTO waypoints(src_id, dst_id, user_id, weight, created_at, updated_at) VALUES (?,?,?,?,?,?)",
               (mid, "dst-alice", T_ALICE, 0.8, now, now))
    db.commit()

    # q.get_mem without user_id returns record
    res = q.get_mem(mid)
    assert res is not None
    assert res["user_id"] == T_ALICE

    # q.get_mem with matching user_id returns record
    res_alice = q.get_mem(mid, user_id=T_ALICE)
    assert res_alice is not None
    assert res_alice["id"] == mid

    # q.get_mem with non-matching user_id returns None
    res_bob = q.get_mem(mid, user_id=T_BOB)
    assert res_bob is None

    # q.get_waypoints_by_src without user_id returns all waypoints
    wps_all = q.get_waypoints_by_src(mid)
    assert len(wps_all) == 1

    # q.get_waypoints_by_src with matching user_id returns waypoints
    wps_alice = q.get_waypoints_by_src(mid, user_id=T_ALICE)
    assert len(wps_alice) == 1

    # q.get_waypoints_by_src with non-matching user_id returns empty list
    wps_bob = q.get_waypoints_by_src(mid, user_id=T_BOB)
    assert len(wps_bob) == 0

    # Memory.get with matching tenant returns memory
    mem_client = Memory()
    m_alice = await mem_client.get(mid, user_id=T_ALICE)
    assert m_alice is not None
    assert m_alice["content"] == "Alice secret memory"

    # Memory.get with non-matching tenant returns None
    m_bob = await mem_client.get(mid, user_id=T_BOB)
    assert m_bob is None
