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
