
import pytest
from unittest.mock import AsyncMock, patch
from openmemory.ops.ingest import ingest_document  # type: ignore[import-untyped]  # type: ignore[import-untyped]

@pytest.mark.asyncio
async def test_ingest_document_chunking_integration():
    """Verify that ingest_document uses chunk_text for splitting."""
    with patch("openmemory.ops.ingest.extract_text", new_callable=AsyncMock) as mock_extract, \
         patch("openmemory.ops.ingest.add_hsg_memory", new_callable=AsyncMock) as mock_add_hsg, \
         patch("openmemory.ops.ingest.q.ins_mem", new_callable=AsyncMock) as mock_ins_mem, \
         patch("openmemory.ops.ingest.db.async_execute", new_callable=AsyncMock) as mock_exec:
        
        long_text = "Sentence one. " * 500
        mock_extract.return_value = {
            "text": long_text,
            "metadata": {"estimated_tokens": 2000, "content_type": "text/plain"}
        }
        mock_add_hsg.return_value = {"id": "child-id"}
        
        res = await ingest_document("test.txt", b"data", cfg={"lg_thresh": 500, "sec_sz": 1000})
        
        assert res["strategy"] == "root-child"
        assert res["child_count"] > 1
        assert mock_add_hsg.call_count == res["child_count"]
        assert mock_ins_mem.called
