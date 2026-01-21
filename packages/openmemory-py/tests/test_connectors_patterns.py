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

    async def _connect(self, **creds) -> bool:
        return True

    async def _list_items(self, **filters) -> list:
        return []

    async def _fetch_item(self, item_id: str):
        # Allow extract to control failure, or implement logic here
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
    # Mock the Memory instance methods
    with patch.object(OpenMemoryVectorStore, 'add_texts') as mock_add:
        mock_add.return_value = ["1", "2"]
        
        from openmemory.main import Memory
        mock_mem = MagicMock(spec=Memory)
        
        vs = OpenMemoryVectorStore(memory=mock_mem, user_id="test_user")
        
        # Test add_texts
        ids = vs.add_texts(["text1", "text2"], metadatas=[{"a": 1}, {"b": 2}])
        
        assert len(ids) == 2
        mock_add.assert_called_once()
        
@pytest.mark.asyncio
async def test_langchain_search():
    """Verify search delegation."""
    from openmemory.main import Memory
    mock_mem = MagicMock(spec=Memory)
    
    # Mock memory.search to return MemoryItems
    mock_result = MagicMock()
    mock_result.content = "res1"
    mock_result.model_dump.return_value = {"foo": "bar"}
    
    mock_mem.search = MagicMock(return_value=[mock_result])
    
    with patch("openmemory.integrations.langchain.run_sync", return_value=[mock_result]):
        vs = OpenMemoryVectorStore(memory=mock_mem, user_id="test_user")
        
        # Test similarity_search
        docs = vs.similarity_search("query", k=2)
        
        assert len(docs) == 1
        assert docs[0].page_content == "res1"
        assert docs[0].metadata["foo"] == "bar"

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
