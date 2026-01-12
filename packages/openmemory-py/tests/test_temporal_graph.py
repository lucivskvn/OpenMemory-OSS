import pytest
import time
from unittest.mock import MagicMock, AsyncMock, patch
from openmemory.temporal_graph.store import insert_fact, update_fact, invalidate_fact, insert_edge, batch_insert_facts
from openmemory.temporal_graph.query import get_current_fact, query_facts_at_time
from openmemory.temporal_graph.timeline import get_subject_timeline, get_change_frequency

@pytest.mark.asyncio
async def test_temporal_graph_crud():
    # Mock DB
    with patch("openmemory.temporal_graph.store.db") as mock_db, \
         patch("openmemory.temporal_graph.store.q") as mock_q, \
         patch("openmemory.temporal_graph.query.db") as mock_query_db, \
         patch("openmemory.temporal_graph.query.q") as mock_query_q:
         
        mock_q.tables = {"temporal_facts": "tf", "temporal_edges": "te"}
        mock_query_q.tables = {"temporal_facts": "tf", "temporal_edges": "te"}
        
        # 1. Insert Fact
        mock_db.transaction.return_value.__aenter__.return_value = None
        mock_db.async_fetchall = AsyncMock(return_value=[]) # No existing facts
        mock_db.async_execute = AsyncMock()
        mock_db.async_commit = AsyncMock()
        
        fid = await insert_fact("Alice", "lives_in", "Wonderland", user_id="u1")
        
        assert fid is not None
        # Verify INSERT called
        args = mock_db.async_execute.call_args_list[-1]
        assert "INSERT INTO tf" in args[0][0]
        assert args[0][1][2] == "Alice" # subject
        
        # 2. Update Fact
        await update_fact(fid, "u1", confidence=0.8)
        args_upd = mock_db.async_execute.call_args_list[-1]
        assert "UPDATE tf" in args_upd[0][0]
        assert "confidence=?" in args_upd[0][0]
        
        # 3. Batch Insert
        await batch_insert_facts([
            {"subject": "Bob", "predicate": "is", "object": "Builder"},
            {"subject": "Bob", "predicate": "has", "object": "Hammer"}
        ], user_id="u1")
        # Should call execute 2 times for inserts inside one transaction
        # (We can't easily count exact execute calls due to other mocks, but ensuring no error is key)

@pytest.mark.asyncio
async def test_temporal_timeline_query():
    with patch("openmemory.temporal_graph.timeline.db") as mock_db, \
         patch("openmemory.temporal_graph.timeline.q") as mock_q:
         
        mock_q.tables = {"temporal_facts": "tf"}
        
        # Mock timeline data
        mock_db.async_fetchall = AsyncMock(return_value=[
            {"subject": "Alice", "predicate": "loc", "object": "A", "confidence": 1.0, "valid_from": 100, "valid_to": 200},
            {"subject": "Alice", "predicate": "loc", "object": "B", "confidence": 1.0, "valid_from": 200, "valid_to": None}
        ])
        
        tl = await get_subject_timeline("Alice", user_id="u1")
        
        assert len(tl) == 3 # 1 created (A), 1 invalidated (A), 1 created (B)
        assert tl[0]["change_type"] == "created"
        assert tl[0]["object"] == "A"
        assert tl[1]["change_type"] == "invalidated"
        assert tl[1]["object"] == "A"
        assert tl[2]["change_type"] == "created"
        assert tl[2]["object"] == "B"
