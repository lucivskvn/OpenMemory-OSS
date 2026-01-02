
import pytest
import asyncio
from unittest.mock import AsyncMock, Mock, patch

from openmemory.memory.scoring import calculate_score
from openmemory.ops.dynamics import SCORING_WEIGHTS
from openmemory.memory.decay import calc_recency_score, compress_vector, DecayCfg

# Mock time for consistent testing
import time

def test_scoring_weights():
    # Verify we are using the dynamics.py weights
    score = calculate_score(
        relevance=1.0, created_at=0, last_seen_at=int(time.time()*1000), salience=1.0, debug=True
    )
    # With full relevance and recent access, score should be high
    assert score["score"] > 0.6
    
    # Check components
    comps = score["components"]
    weights = comps["weights"]
    assert weights["sim"] == SCORING_WEIGHTS["similarity"]
    assert weights["rec"] == SCORING_WEIGHTS["recency"]

def test_decay_compression():
    # Test vector compression logic
    vec = [1.0] * 128
    # factor < 0.7 triggers compression
    f = 0.5
    
    compressed = compress_vector(vec, f, min_dim=32, max_dim=64)
    assert len(compressed) < len(vec)
    assert len(compressed) >= 32
    
    # Verify normalization
    squared_sum = sum(x*x for x in compressed)
    assert abs(squared_sum - 1.0) < 0.001

@pytest.mark.asyncio
async def test_decay_cold_storage_logic():
    # Mock database and vector store
    with patch("openmemory.memory.decay.db", new_callable=AsyncMock) as mock_db, \
         patch("openmemory.memory.decay.store", new_callable=AsyncMock) as mock_store:

        # Setup mock data
        from openmemory.memory.decay import apply_decay, cfg
        
        # Mock fetchall to return a segment with one memory
        mock_db.async_fetchall.side_effect = [
             [{"segment": 1}], # unique segments
             [
                 {
                     "id": "mem_1",
                     "content": "test content",
                     "summary": "test summary",
                     "salience": 0.1, # Low salience to trigger decay
                     "decay_lambda": 0.05,
                     "last_seen_at": 0, # Very old
                     "updated_at": 0,
                     "primary_sector": "semantic",
                     "feedback_score": 0
                 }
             ]
        ]
        
        # Mock vector store
        mock_store.getVector.return_value = Mock(vector=[0.1]*1536, dim=1536)
        
        # Run decay
        await apply_decay()
        
        # Since salience is low and time is long, f should be low.
        # It should trigger compression and/or fingerprinting.
        # Check if stored to _cold sector
        
        calls = mock_store.storeVector.call_args_list
        assert len(calls) > 0
        
        # Verify call args: id, sector, vector, dim
        args = calls[0][0]
        assert args[0] == "mem_1"
        assert "_cold" in args[1] # Should be semantic_cold
        assert len(args[2]) < 1536 # Should be compressed or fingerprinted

@pytest.mark.asyncio
async def test_maintenance_loops():
    # Verify start/stop logic doesn't crash
    from openmemory.memory.decay import start_decay, stop_decay, _decay_task
    from openmemory.ops.maintenance import start_maintenance, stop_maintenance, _maint_task
    
    start_decay()
    # It starts a task, we can't easily check internal state without accessing global
    # But calling it shouldn't raise error.
    await asyncio.sleep(0.1)
    stop_decay()
    
    start_maintenance()
    await asyncio.sleep(0.1)
    stop_maintenance()
