import pytest
import asyncio
import json
from openmemory.ai.mcp import _get_verified_memory, _resolve_mcp_tenant, Memory
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

from openmemory.ai.mcp import handle_mcp_tool_call
from unittest.mock import AsyncMock, MagicMock

@pytest.mark.asyncio
async def test_mcp_tool_handler_tenant_isolation_boundary(monkeypatch):
    monkeypatch.delenv("OM_TENANT", raising=False)
    monkeypatch.delenv("OM_USER_ID", raising=False)

    mem_alice = Memory(user="alice")
    mem_unbound = Memory(user=None)

    tools = ["openmemory_query", "openmemory_store", "openmemory_list"]

    # 1. Unauthenticated / empty server-bound tenant fails closed for all public tools
    for tool in tools:
        search_mock = AsyncMock(return_value=[])
        add_mock = AsyncMock(return_value={"id": "1", "primary_sector": "semantic"})
        hist_mock = MagicMock(return_value=[])
        monkeypatch.setattr(mem_unbound, "search", search_mock)
        monkeypatch.setattr(mem_unbound, "add", add_mock)
        monkeypatch.setattr(mem_unbound, "history", hist_mock)

        query_args = {"query": "test"} if tool == "openmemory_query" else ({"content": "test"} if tool == "openmemory_store" else {})
        res = await handle_mcp_tool_call(tool, query_args, mem_unbound)
        assert len(res) == 1
        assert "Unauthenticated MCP session" in res[0].text
        search_mock.assert_not_called()
        add_mock.assert_not_called()
        hist_mock.assert_not_called()

    # 2. Mismatching caller-supplied tenant fails closed and never calls underlying storage
    for tool in tools:
        search_mock = AsyncMock(return_value=[])
        add_mock = AsyncMock(return_value={"id": "1", "primary_sector": "semantic"})
        hist_mock = MagicMock(return_value=[])
        monkeypatch.setattr(mem_alice, "search", search_mock)
        monkeypatch.setattr(mem_alice, "add", add_mock)
        monkeypatch.setattr(mem_alice, "history", hist_mock)

        query_args = {"query": "test", "user_id": "bob"} if tool == "openmemory_query" else ({"content": "test", "user_id": "bob"} if tool == "openmemory_store" else {"user_id": "bob"})
        res = await handle_mcp_tool_call(tool, query_args, mem_alice)
        assert len(res) == 1
        assert "tenant_mismatch" in res[0].text
        search_mock.assert_not_called()
        add_mock.assert_not_called()
        hist_mock.assert_not_called()

    # 3. Omitted caller user_id defaults to bound tenant
    for tool, uid_val in [("openmemory_query", None), ("openmemory_store", None), ("openmemory_list", None)]:
        search_mock = AsyncMock(return_value=[])
        add_mock = AsyncMock(return_value={"id": "1", "primary_sector": "semantic"})
        hist_mock = MagicMock(return_value=[])
        monkeypatch.setattr(mem_alice, "search", search_mock)
        monkeypatch.setattr(mem_alice, "add", add_mock)
        monkeypatch.setattr(mem_alice, "history", hist_mock)

        query_args = {"query": "test"} if tool == "openmemory_query" else ({"content": "test"} if tool == "openmemory_store" else {})
        res = await handle_mcp_tool_call(tool, query_args, mem_alice)
        assert "Error" not in res[0].text

        if tool == "openmemory_query":
            assert search_mock.call_args.kwargs["user_id"] == "alice"
        elif tool == "openmemory_store":
            assert add_mock.call_args.kwargs["user_id"] == "alice"
        elif tool == "openmemory_list":
            assert hist_mock.call_args.kwargs["user_id"] == "alice"

    # 4. Matching caller user_id succeeds and receives bound tenant
    for tool in tools:
        search_mock = AsyncMock(return_value=[])
        add_mock = AsyncMock(return_value={"id": "1", "primary_sector": "semantic"})
        hist_mock = MagicMock(return_value=[])
        monkeypatch.setattr(mem_alice, "search", search_mock)
        monkeypatch.setattr(mem_alice, "add", add_mock)
        monkeypatch.setattr(mem_alice, "history", hist_mock)

        query_args = {"query": "test", "user_id": "alice"} if tool == "openmemory_query" else ({"content": "test", "user_id": "alice"} if tool == "openmemory_store" else {"user_id": "alice"})
        res = await handle_mcp_tool_call(tool, query_args, mem_alice)
        assert "Error" not in res[0].text

        if tool == "openmemory_query":
            assert search_mock.call_args.kwargs["user_id"] == "alice"
        elif tool == "openmemory_store":
            assert add_mock.call_args.kwargs["user_id"] == "alice"
        elif tool == "openmemory_list":
            assert hist_mock.call_args.kwargs["user_id"] == "alice"

    # 5. Empty caller identity ("") defaults to bound tenant
    for tool in tools:
        search_mock = AsyncMock(return_value=[])
        add_mock = AsyncMock(return_value={"id": "1", "primary_sector": "semantic"})
        hist_mock = MagicMock(return_value=[])
        monkeypatch.setattr(mem_alice, "search", search_mock)
        monkeypatch.setattr(mem_alice, "add", add_mock)
        monkeypatch.setattr(mem_alice, "history", hist_mock)

        query_args = {"query": "test", "user_id": ""} if tool == "openmemory_query" else ({"content": "test", "user_id": ""} if tool == "openmemory_store" else {"user_id": ""})
        res = await handle_mcp_tool_call(tool, query_args, mem_alice)
        assert "Error" not in res[0].text

        if tool == "openmemory_query":
            assert search_mock.call_args.kwargs["user_id"] == "alice"
        elif tool == "openmemory_store":
            assert add_mock.call_args.kwargs["user_id"] == "alice"
        elif tool == "openmemory_list":
            assert hist_mock.call_args.kwargs["user_id"] == "alice"
