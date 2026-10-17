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
async def test_get_mem_and_waypoints_tenant_isolation():
    from openmemory.main import Memory

    db.execute("DELETE FROM memories")
    db.execute("DELETE FROM waypoints")
    db.commit()

    now = 1000
    m_id = "mem-tenant-test-1"

    # Insert memory for Alice
    q.ins_mem(id=m_id, user_id=T_ALICE, content="Alice private content", primary_sector="semantic", created_at=now, updated_at=now, last_seen_at=now)

    # Insert waypoints for Alice and Bob
    db.execute("INSERT INTO waypoints(src_id, dst_id, user_id, weight, created_at, updated_at) VALUES (?,?,?,?,?,?)",
               (m_id, "dst-alice", T_ALICE, 0.8, now, now))
    db.execute("INSERT INTO waypoints(src_id, dst_id, user_id, weight, created_at, updated_at) VALUES (?,?,?,?,?,?)",
               (m_id, "dst-bob", T_BOB, 0.9, now, now))
    db.commit()

    # q.get_mem without user_id returns record
    mem_unscoped = q.get_mem(m_id)
    assert mem_unscoped is not None
    assert mem_unscoped["user_id"] == T_ALICE

    # q.get_mem with Alice user_id returns record
    mem_alice = q.get_mem(m_id, T_ALICE)
    assert mem_alice is not None
    assert mem_alice["content"] == "Alice private content"

    # q.get_mem with Bob user_id returns None (isolated)
    mem_bob = q.get_mem(m_id, T_BOB)
    assert mem_bob is None

    # Memory.get with Alice user_id
    mem_client_alice = Memory(user=T_ALICE)
    res_alice = await mem_client_alice.get(m_id)
    assert res_alice is not None

    # Memory.get with Bob user_id
    mem_client_bob = Memory(user=T_BOB)
    res_bob = await mem_client_bob.get(m_id)
    assert res_bob is None

    # q.get_waypoints_by_src for Alice returns only Alice waypoint
    wps_alice = q.get_waypoints_by_src(m_id, T_ALICE)
    assert len(wps_alice) == 1
    assert wps_alice[0]["dst_id"] == "dst-alice"

    # q.get_waypoints_by_src for Bob returns only Bob waypoint
    wps_bob = q.get_waypoints_by_src(m_id, T_BOB)
    assert len(wps_bob) == 1
    assert wps_bob[0]["dst_id"] == "dst-bob"
