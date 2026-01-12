import pytest
from unittest.mock import MagicMock, AsyncMock, patch
from openmemory.memory.user_summary import gen_user_summary, gen_user_summary_async  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.memory.decay import on_query_hit  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.memory.reflect import mark_consolidated, boost  # type: ignore[import-untyped]  # type: ignore[import-untyped]

@pytest.mark.asyncio
async def test_user_summary_double_counting():
    # Test that save events are counted correctly (fix for double counting)
    mems = [
        {"meta": {"ide_event_type": "save", "ide_file_path": "a.py"}, "created_at": 1000},
        {"meta": {"ide_event_type": "save", "ide_file_path": "b.py"}, "created_at": 2000},
        {"meta": {"ide_event_type": "open", "ide_file_path": "c.py"}, "created_at": 3000}
    ]
    # We need to ensure logic handles dict meta correctly as done in the code
    # The code expects dict or json string. Here we pass dicts.
    # The code: if d.get("meta"): ... meta = json.loads... if isinstance(str)...
    
    summary = gen_user_summary(mems)
    # Expected: 3 memories, 2 saves.
    # Before fix: it would be 4 saves (doubled).
    assert "2 saves" in summary
    assert "3 memories" in summary

@pytest.mark.asyncio
async def test_decay_on_query_hit_commit():
    with patch("openmemory.memory.decay.q") as mock_q, \
         patch("openmemory.memory.decay.db") as mock_db, \
         patch("openmemory.memory.decay.store") as mock_store: # Stop potential real DB calls
         
        mock_q.get_mem = AsyncMock(return_value={"id": "m1", "salience": 0.5, "generated_summary": "sum", "content": "cont"})
        mock_db.async_execute = AsyncMock()
        mock_db.async_commit = AsyncMock()
        
        # Enable reinforce
        with patch("openmemory.memory.decay.cfg") as mock_cfg:
            mock_cfg.reinforce_on_query = True
            mock_cfg.regeneration_enabled = False
            
            await on_query_hit("m1", "semantic", user_id="u1")
            
            mock_db.async_execute.assert_called_once()
            # Verify commit called
            mock_db.async_commit.assert_called_once()

@pytest.mark.asyncio
async def test_reflect_helpers_commit():
    with patch("openmemory.memory.reflect.db") as mock_db, \
         patch("openmemory.memory.reflect.q") as mock_q:
        
        mock_db.async_execute = AsyncMock()
        mock_db.async_commit = AsyncMock()
        mock_q.tables = {"memories": "memories"}
        
        # Test Default (Commit=True)
        await mark_consolidated(["m1"])
        assert mock_db.async_commit.call_count == 1
        
        mock_db.async_commit.reset_mock()
        
        # Test Commit=False
        await mark_consolidated(["m1"], commit=False)
        assert mock_db.async_commit.call_count == 0
        
        # Same for boost
        await boost(["m1"], commit=True)
        assert mock_db.async_commit.call_count == 1
        
        mock_db.async_commit.reset_mock()
        await boost(["m1"], commit=False)
        assert mock_db.async_commit.call_count == 0
