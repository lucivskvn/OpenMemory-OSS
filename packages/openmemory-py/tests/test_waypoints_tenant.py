import pytest
import time
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
async def test_get_mem_and_waypoints_by_src_tenant_isolation():
    db.execute("DELETE FROM memories WHERE user_id IN (?, ?)", (T_ALICE, T_BOB))
    db.execute("DELETE FROM waypoints WHERE user_id IN (?, ?)", (T_ALICE, T_BOB))
    db.commit()

    now = int(time.time() * 1000)
    mem_id = "shared-mem-id"

    # Insert memory for Alice
    q.ins_mem(id=mem_id, user_id=T_ALICE, content="Alice memory content", primary_sector="semantic", created_at=now, updated_at=now)

    # Insert waypoints for Alice and Bob
    db.execute("INSERT INTO waypoints(src_id, dst_id, user_id, weight, created_at, updated_at) VALUES (?,?,?,?,?,?)",
               (mem_id, "dst-alice", T_ALICE, 0.8, now, now))
    db.execute("INSERT INTO waypoints(src_id, dst_id, user_id, weight, created_at, updated_at) VALUES (?,?,?,?,?,?)",
               (mem_id, "dst-bob", T_BOB, 0.9, now, now))
    db.commit()

    # q.get_mem with T_ALICE returns row
    alice_mem = q.get_mem(mem_id, user_id=T_ALICE)
    assert alice_mem is not None
    assert alice_mem["user_id"] == T_ALICE

    # q.get_mem with T_BOB returns None
    bob_mem = q.get_mem(mem_id, user_id=T_BOB)
    assert bob_mem is None

    # q.get_waypoints_by_src with T_ALICE returns only Alice waypoint
    alice_wps = q.get_waypoints_by_src(mem_id, user_id=T_ALICE)
    assert len(alice_wps) == 1
    assert alice_wps[0]["dst_id"] == "dst-alice"

    # q.get_waypoints_by_src with T_BOB returns only Bob waypoint
    bob_wps = q.get_waypoints_by_src(mem_id, user_id=T_BOB)
    assert len(bob_wps) == 1
    assert bob_wps[0]["dst_id"] == "dst-bob"
