import pytest
import asyncio
import json
from openmemory.ai.mcp import _get_verified_memory, _resolve_mcp_tenant, _execute_mcp_tool, Memory
from openmemory.core.db import db, q

@pytest.fixture(autouse=True)
def setup_db(tmp_path, monkeypatch):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("OM_DATABASE_URL", f"sqlite:///{db_file}")
    db.conn = None
    db.connect()

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
async def test_mcp_tenant_query_store_list_scenarios(monkeypatch):
    monkeypatch.delenv("OM_TENANT", raising=False)
    monkeypatch.delenv("OM_USER_ID", raising=False)

    mem_alice = Memory(user="alice")
    mem_unbound = Memory(user=None)

    # 1. Bound session with matching user_id or omitted user_id succeeds
    t1, err1 = _resolve_mcp_tenant(mem_alice, {"user_id": "alice"})
    assert err1 is None
    assert t1 == "alice"

    t2, err2 = _resolve_mcp_tenant(mem_alice, {})
    assert err2 is None
    assert t2 == "alice"

    # 2. Bound session with mismatched user_id fails
    t3, err3 = _resolve_mcp_tenant(mem_alice, {"user_id": "bob"})
    assert t3 is None
    assert "tenant_mismatch" in err3

    # 3. Unbound session fails closed
    t4, err4 = _resolve_mcp_tenant(mem_unbound, {"user_id": "alice"})
    assert t4 is None
    assert "Unauthenticated MCP session" in err4

    t5, err5 = _resolve_mcp_tenant(mem_unbound, {})
    assert t5 is None
    assert "Unauthenticated MCP session" in err5

@pytest.mark.asyncio
async def test_mcp_tool_handler_boundary_coverage(monkeypatch):
    monkeypatch.delenv("OM_TENANT", raising=False)
    monkeypatch.delenv("OM_USER_ID", raising=False)

    mem_alice = Memory(user="alice")
    mem_unbound = Memory(user=None)

    tools = ["openmemory_query", "openmemory_store", "openmemory_list"]

    for tool_name in tools:
        args_mismatch = {"query": "test", "content": "test", "user_id": "bob"}
        res_unbound = await _execute_mcp_tool(mem_unbound, tool_name, args_mismatch)
        assert len(res_unbound) == 1
        assert "Unauthenticated MCP session" in res_unbound[0].text

        res_mismatch = await _execute_mcp_tool(mem_alice, tool_name, args_mismatch)
        assert len(res_mismatch) == 1
        assert "tenant_mismatch" in res_mismatch[0].text

    # Store a memory for Alice using matching, omitted, empty, and whitespace user_id
    for uid_variant in ["alice", None, "", "   "]:
        store_args = {"content": f"Secret for variant {uid_variant}", "type": "contextual"}
        if uid_variant is not None:
            store_args["user_id"] = uid_variant
        res_store = await _execute_mcp_tool(mem_alice, "openmemory_store", store_args)
        assert "Stored memory" in res_store[0].text

    # Query Alice's memories with whitespace user_id
    res_query = await _execute_mcp_tool(mem_alice, "openmemory_query", {"query": "Secret", "user_id": "  alice  "})
    assert "Found" in res_query[0].text

    # List Alice's memories with omitted user_id
    res_list = await _execute_mcp_tool(mem_alice, "openmemory_list", {})
    assert "Secret for variant" in res_list[0].text
