import pytest
import asyncio
import json
from openmemory.ai.mcp import _get_verified_memory, _resolve_mcp_tenant, Memory
from openmemory.core.db import db, q
from openmemory.core.config import env

@pytest.fixture(autouse=True)
def setup_db(tmp_path, monkeypatch):
    db_file = tmp_path / "test.db"
    monkeypatch.setattr(env, "database_url", f"sqlite:///{db_file}")
    if db.conn:
        db.conn.close()
        db.conn = None
    db.connect()
    yield
    if db.conn:
        db.conn.close()
        db.conn = None

@pytest.mark.asyncio
async def test_mcp_tenant_get_and_delete_scenarios(monkeypatch):
    monkeypatch.delenv("OM_TENANT", raising=False)
    monkeypatch.delenv("OM_USER_ID", raising=False)

    mem = Memory(user="alice")

    # Add a memory for Alice
    m_alice = await mem.add("Alice secret memory", user_id="alice")
    mid_alice = m_alice.get("root_memory_id") or m_alice.get("id")

    # 1. Matching tenant succeeds
    res_get, tenant, err_get = await _get_verified_memory(mem, {"id": mid_alice, "user_id": "alice"})
    assert err_get is None
    assert tenant == "alice"
    assert res_get["id"] == mid_alice

    # 2. Mismatching tenant fails
    res_mismatch, tenant_m, err_mismatch = await _get_verified_memory(mem, {"id": mid_alice, "user_id": "bob"})
    assert res_mismatch is None
    assert "tenant_mismatch" in err_mismatch

    # 3. Omitted/empty user_id with bound session defaults to bound tenant
    res_bound, tenant_b, err_bound = await _get_verified_memory(mem, {"id": mid_alice})
    assert err_bound is None
    assert tenant_b == "alice"
    assert res_bound["id"] == mid_alice

    # 4. Unbound session WITHOUT user_id fails closed
    mem_unbound = Memory(user=None)
    res_unbound1, tenant_u1, err_unbound1 = await _get_verified_memory(mem_unbound, {"id": mid_alice})
    assert res_unbound1 is None
    assert "Unauthenticated MCP session" in err_unbound1

    # 5. Unbound session WITH non-empty claimed user_id STILL fails closed (prevents claimed identity bypass)
    res_unbound2, tenant_u2, err_unbound2 = await _get_verified_memory(mem_unbound, {"id": mid_alice, "user_id": "alice"})
    assert res_unbound2 is None
    assert "Unauthenticated MCP session" in err_unbound2

    # 6. Ownerless memory record (user_id is None) is rejected for any bound tenant
    db.execute("INSERT INTO memories (id, user_id, content, primary_sector, created_at, salience, decay_lambda, version) VALUES (?, NULL, ?, ?, ?, 1.0, 0.02, 1)", ("m-ownerless", "Ownerless memory content", "semantic", 1000000000))
    db.commit()
    res_ownerless, tenant_o, err_ownerless = await _get_verified_memory(mem, {"id": "m-ownerless"})
    assert res_ownerless is None
    assert "not found for user" in err_ownerless

@pytest.mark.asyncio
async def test_temporal_fact_mutation_tenant_isolation(monkeypatch):
    from openmemory.temporal_graph.store import insert_fact, update_fact, invalidate_fact, delete_fact

    fact_id = await insert_fact("AliceSubj", "AlicePred", "AliceObj", user_id="alice", confidence=0.8)

    # Fail closed on empty/whitespace user_id
    with pytest.raises(ValueError):
        await update_fact(fact_id, "", confidence=0.1)
    with pytest.raises(ValueError):
        await invalidate_fact(fact_id, "")
    with pytest.raises(ValueError):
        await delete_fact(fact_id, "")

    # 1. Bob attempts update with user_id="bob" -> no effect on Alice's fact
    await update_fact(fact_id, "bob", confidence=0.1, metadata={"hacked": True})
    fact_row = db.fetchone("SELECT confidence, metadata FROM temporal_facts WHERE id=?", (fact_id,))
    assert fact_row["confidence"] == 0.8
    assert fact_row["metadata"] is None

    # 2. Alice updates with user_id="alice" -> succeeds
    await update_fact(fact_id, "alice", confidence=0.9, metadata={"updated": True})
    fact_row = db.fetchone("SELECT confidence, metadata FROM temporal_facts WHERE id=?", (fact_id,))
    assert fact_row["confidence"] == 0.9
    assert json.loads(fact_row["metadata"]) == {"updated": True}

    # 3. Bob attempts invalidate with user_id="bob" -> no effect
    await invalidate_fact(fact_id, "bob", valid_to=2000000000)
    fact_row = db.fetchone("SELECT valid_to FROM temporal_facts WHERE id=?", (fact_id,))
    assert fact_row["valid_to"] is None

    # 4. Alice invalidates with user_id="alice" -> succeeds
    await invalidate_fact(fact_id, "alice", valid_to=2000000000)
    fact_row = db.fetchone("SELECT valid_to FROM temporal_facts WHERE id=?", (fact_id,))
    assert fact_row["valid_to"] == 2000000000

    # 5. Bob attempts delete with user_id="bob" -> no effect
    await delete_fact(fact_id, "bob")
    fact_row = db.fetchone("SELECT id FROM temporal_facts WHERE id=?", (fact_id,))
    assert fact_row is not None

    # 6. Alice deletes with user_id="alice" -> succeeds
    await delete_fact(fact_id, "alice")
    fact_row = db.fetchone("SELECT id FROM temporal_facts WHERE id=?", (fact_id,))
    assert fact_row is None
