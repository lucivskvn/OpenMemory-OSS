import pytest
from unittest.mock import MagicMock, patch, AsyncMock
from openmemory.connectors.base import BaseConnector, ConnectorError  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.integrations.langchain import OpenMemoryVectorStore  # type: ignore[import-untyped]  # type: ignore[import-untyped]

# === Connector Pattern Tests ===

class MockConnector(BaseConnector):
    def __init__(self):
        super().__init__()
        
    async def authenticate(self):
        pass
        
    async def extract(self, **kwargs):
        raise ConnectorError("Simulated Failure", retryable=True)

@pytest.mark.asyncio
async def test_connector_error_hierarchy():
    """Verify connectors raise correct error types."""
    c = MockConnector()
    with pytest.raises(ConnectorError) as exc:
        await c.extract()
    assert exc.value.retryable is True
    assert str(exc.value) == "Simulated Failure"

# === LangChain Integration Tests ===

@pytest.mark.asyncio
async def test_langchain_interface():
    """Verify OpenMemoryVectorStore follows LC interface."""
    # Mock the internal client/store calls
    with patch("openmemory.integrations.langchain.add_hsg_memories", new_callable=AsyncMock) as mock_add:
        mock_add.return_value = [{"id": "1"}, {"id": "2"}]
        
        vs = OpenMemoryVectorStore(user_id="test_user")
        
        # Test add_texts
        ids = await vs.aadd_texts(["text1", "text2"], metadatas=[{"a": 1}, {"b": 2}])
        
        assert len(ids) == 2
        mock_add.assert_called_once()
        args = mock_add.call_args
        # checking args passed to add_hsg_memories
        # assert args[1] == ... hard to check exact structure without unpacking
        
@pytest.mark.asyncio
async def test_langchain_search():
    """Verify search delegation."""
    with patch("openmemory.integrations.langchain.hsg_query", new_callable=AsyncMock) as mock_query:
        # returns list of dicts
        mock_query.return_value = [
            {"id": "1", "content": "res1", "metadata": {"foo": "bar"}, "similarity": 0.9},
            {"id": "2", "content": "res2", "metadata": {"baz": "qux"}, "similarity": 0.8}
        ]
        
        vs = OpenMemoryVectorStore(user_id="test_user")
        
        # Test similarity_search
        docs = await vs.asimilarity_search_with_score("query", k=2)
        
        assert len(docs) == 2
        doc1, score1 = docs[0]
        assert doc1.page_content == "res1"
        assert score1 == 0.9
        assert doc1.metadata["foo"] == "bar"

@pytest.mark.asyncio
async def test_web_crawler_delegation():
    """Verify WebCrawler uses central extraction logic."""
    from openmemory.connectors.web_crawler import WebCrawlerConnector  # type: ignore[import-untyped]
    
    with patch("openmemory.ops.extract.extract_url", new_callable=AsyncMock) as mock_extract:
        mock_extract.return_value = {
            "text": "Cleaned Text",
            "metadata": {"title": "Test Page", "foo": "bar"}
        }
        
        crawler = WebCrawlerConnector(user_id="test_user")
        
        # Should call extract_url internally
        item = await crawler.fetch_item("http://example.com")
        
        assert item.text == "Cleaned Text"
        assert item.metadata["title"] == "Test Page"
        assert item.metadata["source"] == "web_crawler"
        
        mock_extract.assert_called_once_with("http://example.com", user_id="test_user")
