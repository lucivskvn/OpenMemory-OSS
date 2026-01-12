
import pytest
import json
from unittest.mock import MagicMock, AsyncMock, patch

@pytest.mark.asyncio
async def test_ingest_url_accepts_tags():
    with patch("openmemory.ops.ingest.extract_url") as mock_extract, \
         patch("openmemory.ops.ingest.add_hsg_memory") as mock_add_mem, \
         patch("openmemory.ops.ingest.db.transaction"):
         
        mock_extract.return_value = {
            "text": "test content",
            "metadata": {"estimated_tokens": 100, "content_type": "text/html"}
        }
        mock_add_mem.return_value = {"id": "mem_1"}
        
        from openmemory.ops.ingest import ingest_url  # type: ignore[import-untyped]
        
        tags = ["news", "tech"]
        await ingest_url("http://test.com", tags=tags, user_id="u1")
        
        args = mock_add_mem.call_args
        # Check if tags were passed correctly (as JSON string)
        # add_hsg_memory(content, tags, metadata, user_id, ...)
        passed_tags = args[0][1]
        assert json.loads(passed_tags) == tags

@pytest.mark.asyncio
async def test_ingest_document_root_child_propagate_tags():
    with patch("openmemory.ops.ingest.extract_text") as mock_extract, \
         patch("openmemory.ops.ingest.mk_root") as mock_mk_root, \
         patch("openmemory.ops.ingest.mk_child") as mock_mk_child, \
         patch("openmemory.ops.ingest.link"), \
         patch("openmemory.ops.ingest.db.transaction"):
         
        mock_extract.return_value = {
            "text": "long content " * 1000,
            "metadata": {"estimated_tokens": 10000, "content_type": "text/plain"}
        }
        mock_mk_root.return_value = "root_1"
        
        from openmemory.ops.ingest import ingest_document  # type: ignore[import-untyped]
        
        tags = ["dataset", "large"]
        await ingest_document("text", "data", tags=tags, user_id="u1", cfg={"force_root": True})
        
        # Verify mk_root called with tags
        root_args = mock_mk_root.call_args
        assert "tags" in root_args.kwargs
        assert json.loads(root_args.kwargs["tags"]) == tags
        
        # Verify mk_child called with tags
        child_args = mock_mk_child.call_args
        assert "tags" in child_args.kwargs
        assert json.loads(child_args.kwargs["tags"]) == tags
