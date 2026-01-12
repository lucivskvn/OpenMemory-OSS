import pytest
from unittest.mock import MagicMock, AsyncMock, patch, ANY
from openmemory.memory.embed import embed_multi_sector

@pytest.mark.asyncio
async def test_embed_transaction_safety():
    with patch("openmemory.memory.embed.q") as mock_q, \
         patch("openmemory.memory.embed.embed_for_sector", AsyncMock(return_value=[0.1]*64)):
         
        mock_q.ins_log = AsyncMock()
        mock_q.upd_log = AsyncMock()
        
        # Test Commit=True (Default)
        await embed_multi_sector("id", "txt", ["semantic"])
        mock_q.ins_log.assert_called_with(id="id", model="multi-sector", status="pending", ts=ANY, err=None, user_id=None, commit=True)
        mock_q.upd_log.assert_called_with(id="id", status="completed", err=None, user_id=None, commit=True)
        
        # Test Commit=False (Usage in HSG)
        await embed_multi_sector("id", "txt", ["semantic"], commit=False)
        mock_q.ins_log.assert_called_with(id="id", model="multi-sector", status="pending", ts=ANY, err=None, user_id=None, commit=False)
        mock_q.upd_log.assert_called_with(id="id", status="completed", err=None, user_id=None, commit=False)
