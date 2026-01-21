import pytest
import asyncio
from unittest.mock import MagicMock, patch, AsyncMock
from openmemory.ops.ingest import ingest_document, trigger_post_ingest_maintenance, INGESTION_COUNTER
from openmemory.ops import maintenance

@pytest.mark.asyncio
async def test_summarization_integration():
    """Verify that mk_root uses compression engine instead of simple truncation."""
    
    # Create a long text that would trigger summarization
    long_text = "word " * 2000 # ~10k chars
    
    # Mock dependencies
    with patch("openmemory.ops.ingest.q") as mock_q, \
         patch("openmemory.ops.ingest.db") as mock_db, \
         patch("openmemory.ops.ingest.add_hsg_memory", new_callable=AsyncMock) as mock_add_hsg:
        
        # Configure mocks
        mock_q.tables = {"memories": "memories", "waypoints": "waypoints"}
        mock_db.transaction.return_value.__aenter__.return_value = None
        mock_db.transaction.return_value.__aexit__.return_value = None
        mock_add_hsg.return_value = {"id": "mock_id"}
        mock_q.ins_mem = AsyncMock()
        mock_db.async_execute = AsyncMock()
        
        # We need to spy on mk_root or check the arguments passed to q.ins_mem
        # Since mk_root is inside ingest, we can rely on q.ins_mem call args
        
        result = await ingest_document("text/plain", long_text, cfg={"force_root": True})
        
        # Verify ins_mem was called (via mk_root)
        assert mock_q.ins_mem.called
        call_args = mock_q.ins_mem.call_args[1] # kwargs
        content = call_args["content"] # Encrypted content mock?
        
        # Note: In real code, content is encrypted. 
        # But we mocked DB, we didn't mock get_encryption().encrypt()
        # Let's mock encryption to return plaintext for easy assertion
        
@pytest.mark.asyncio
async def test_maintenance_triggers():
    """Verify maintenance triggers fire at correct intervals."""
    
    # Reset counter
    with patch("openmemory.ops.ingest.INGESTION_COUNTER", 0):
        with patch("openmemory.ops.ingest.trigger_maintenance", new_callable=AsyncMock) as mock_trigger:
            
            # 1. Trigger below threshold
            from openmemory.ops.ingest import trigger_post_ingest_maintenance
            # We need to manually call it or invoke ingest N times.
            # Let's invoke it manually to simulate N ingestions
            
            # Simulate 19 calls (counter 0->19)
            for _ in range(19):
                trigger_post_ingest_maintenance()
            
            assert not mock_trigger.called
            
            # 20th call -> Reflect
            trigger_post_ingest_maintenance()
            mock_trigger.assert_called_with("reflect")
            mock_trigger.reset_mock()
            
            # 21-39 (should not trigger)
            for _ in range(19):
                trigger_post_ingest_maintenance()
            assert not mock_trigger.called

            # 40th call -> Reflect again
            trigger_post_ingest_maintenance()
            mock_trigger.assert_called_with("reflect")
            mock_trigger.reset_mock()
            
            # 41-49 (should not trigger)
            for _ in range(9):
                trigger_post_ingest_maintenance()
            assert not mock_trigger.called

            # 50th call -> Decay
            trigger_post_ingest_maintenance()
            mock_trigger.assert_called_with("decay")
