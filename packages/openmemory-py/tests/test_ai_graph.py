import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from openmemory.core.types import LgmStoreReq, LgmRetrieveReq, LgmContextReq, LgStoreResult, LgRetrieveResult, GraphMemoryItem  # type: ignore[import-untyped]  # type: ignore[import-untyped]

# Check availability of module
try:
    from openmemory.ai.graph import store_node_mem, retrieve_node_mems, get_graph_ctx, NODE_SECTOR_MAP  # type: ignore[import-untyped]
except ImportError:
    pytest.skip("openmemory.ai.graph module not found", allow_module_level=True)

@pytest.mark.asyncio
async def test_store_node_mem_basic():
    with patch("openmemory.ai.graph.add_hsg_memory", new_callable=AsyncMock) as mock_add:
        # Mocks
        mock_add.return_value = {
            "id": "mem1",
            "content": "Test content",
            "primary_sector": "episodic",
            "sectors": ["episodic"],
            "created_at": 1000,
            "salience": 0.6,
            "generated_summary": "Summ"
        }

        # Request
        req = LgmStoreReq(
            node="observe",
            content="Test content",
            user_id="u1"
        )

        # Execute
        res = await store_node_mem(req)

        # Verify
        assert res.success
        assert res.memory_id == "mem1"
        assert res.node == "observe"
        assert res.memory.id == "mem1"
        assert res.memory.node == "observe"

        mock_add.assert_called_once()
        ca = mock_add.call_args
        assert ca.kwargs["content"] == "Test content"
        assert "lgm:node:observe" in ca.kwargs["tags"]
        assert ca.kwargs["user_id"] == "u1"

@pytest.mark.asyncio
async def test_retrieve_node_mems_query():
    with patch("openmemory.ai.graph.hsg_query", new_callable=AsyncMock) as mock_query:
        # Mock Response
        mock_query.return_value = [
            {
                "id": "mem1",
                "content": "C1",
                "primary_sector": "semantic",
                "sectors": ["semantic"],
                "created_at": 1000,
                "metadata": {"lgm": {"namespace": "default"}},
                "score": 0.9,
                "user_id": "u1",
                "tags": [],
            }
        ]

        req = LgmRetrieveReq(node="plan", query="foo", user_id="u1")
        res = await retrieve_node_mems(req)

        assert res.success
        assert len(res.memories) == 1
        assert res.memories[0].id == "mem1"
        assert res.memories[0].node == "plan"

        mock_query.assert_called_once()
        ca = mock_query.call_args
        assert ca.args[0] == "foo" # query
        filters = ca.kwargs.get("filters")
        assert filters["user_id"] == "u1"  # type: ignore[index]

@pytest.mark.asyncio
async def test_retrieve_node_mems_tag_search():
    # Mock get_mems_by_tag helper? It's inside graph.py but not exposed?
    # Actually store_node_mem calls add_hsg_memory.
    # retrieve_node_mems calls get_mems_by_tag which calls db.async_fetchall.
    # So we should patch openmemory.ai.graph.db.async_fetchall

    with patch("openmemory.ai.graph.db.async_fetchall", new_callable=AsyncMock) as mock_fetch:
        # Returns list of dicts (RealDictCursor simulation)
        mock_fetch.return_value = [
            {
                "id": "mem2",
                "content": "C2",
                "primary_sector": "semantic",
                "created_at": 2000,
                "updated_at": 2000,
                "last_seen_at": 2000,
                "salience": 0.5,
                "decay_lambda": 0.02,
                "version": 1,
                "segment": 0,
                "user_id": "u1",
                "tags": '["lgm:node:plan"]',
                "metadata": '{"lgm": {"namespace": "default"}}',
                "generated_summary": None,
                "simhash": None,
                "mean_dim": 0,
                "mean_vec": None,
                "compressed_vec": None,
                "feedback_score": 0.0
            }
        ]

        req = LgmRetrieveReq(node="plan", user_id="u1")
        res = await retrieve_node_mems(req)

        assert res.success
        assert len(res.memories) == 1
        assert res.memories[0].id == "mem2"
        assert res.memories[0].node == "plan"

@pytest.mark.asyncio
async def test_get_graph_ctx_aggregation():
    with patch("openmemory.ai.graph.retrieve_node_mems", new_callable=AsyncMock) as mock_retr:

        def side_effect(req: LgmRetrieveReq):
            return LgRetrieveResult(
                success=True,
                memories=[
                    GraphMemoryItem(
                        id=f"m_{req.node}",
                        content=f"Content for {req.node}",
                        primary_sector="semantic",
                        sectors=["semantic"],
                        node=str(req.node),
                        created_at=1000, updated_at=1000, last_seen_at=1000,
                        meta={},
                        user_id="u1"
                    )
                ]
            )
        mock_retr.side_effect = side_effect

        req = LgmContextReq(user_id="u1", limit=100)
        res = await get_graph_ctx(req)

        assert res.success
        # Should contain entries for each node in map (5 nodes)
        assert len(res.nodes) == 5
        assert "Content for observe" in res.context
