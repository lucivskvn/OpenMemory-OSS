import pytest
import asyncio
import json
from openmemory.ai.mcp import _get_verified_memory, _resolve_mcp_tenant, Memory
from openmemory.core.db import db, q

@pytest.fixture(autouse=True)
def setup_db(tmp_path, monkeypatch):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("OM_DATABASE_URL", f"sqlite:///{db_file}")
    from openmemory.core.config import env
    orig_url = env.database_url
    env.database_url = f"sqlite:///{db_file}"
    if db.conn:
        db.conn.close()
    db.conn = None
    db.connect()
    yield
    if db.conn:
        db.conn.close()
    db.conn = None
    env.database_url = orig_url

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

from openmemory.ai.mcp import _handle_mcp_list

@pytest.mark.asyncio
async def test_mcp_list_boundary_handler_cases(monkeypatch):
    monkeypatch.delenv("OM_TENANT", raising=False)
    monkeypatch.delenv("OM_USER_ID", raising=False)

    mem_alice = Memory(user="alice")
    mem_bob = Memory(user="bob")

    await mem_alice.add("Alice secret memory", user_id="alice")
    await mem_bob.add("Bob secret memory", user_id="bob")
    db.execute("INSERT INTO memories (id, user_id, content, primary_sector, created_at, salience, decay_lambda, version) VALUES (?, NULL, ?, ?, ?, 1.0, 0.02, 1)", ("m-ownerless-list", "Ownerless content", "semantic", 1000000000))
    db.commit()

    # 1. Matching authenticated tenant returns only that tenant's records
    res_alice = await _handle_mcp_list(mem_alice, {"user_id": "alice"})
    parsed_alice = json.loads(res_alice[0].text)
    assert len(parsed_alice) >= 1
    assert all(m["user_id"] == "alice" for m in parsed_alice)

    # 2. Omitted and whitespace-only user_id remain bound to authenticated tenant
    res_omitted = await _handle_mcp_list(mem_alice, {})
    parsed_omitted = json.loads(res_omitted[0].text)
    assert len(parsed_omitted) >= 1
    assert all(m["user_id"] == "alice" for m in parsed_omitted)

    res_ws = await _handle_mcp_list(mem_alice, {"user_id": "   "})
    parsed_ws = json.loads(res_ws[0].text)
    assert len(parsed_ws) >= 1
    assert all(m["user_id"] == "alice" for m in parsed_ws)

    # 3. Wrong-tenant value is rejected
    res_wrong = await _handle_mcp_list(mem_alice, {"user_id": "bob"})
    assert "tenant_mismatch" in res_wrong[0].text

    # 4. Unbound session fails closed even when caller supplies a non-empty identity
    mem_unbound = Memory(user=None)
    res_unbound = await _handle_mcp_list(mem_unbound, {"user_id": "alice"})
    assert "Unauthenticated MCP session" in res_unbound[0].text

    # 5. Ownerless records are never returned to any tenant
    for record in parsed_alice:
        assert record["id"] != "m-ownerless-list"
