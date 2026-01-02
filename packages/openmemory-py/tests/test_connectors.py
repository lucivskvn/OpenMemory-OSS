import asyncio
import unittest
from unittest.mock import MagicMock, patch
from openmemory.connectors.base import base_connector, SourceItem, SourceContent
from openmemory.connectors.github import github_connector
from openmemory.connectors.notion import notion_connector

class TestBaseConnector(unittest.IsolatedAsyncioTestCase):
    async def test_run_blocking(self):
        connector = github_connector("test_user")
        
        def blocking_func(x):
            import time
            time.sleep(0.1)
            return x * 2
            
        start = asyncio.get_running_loop().time()
        res = await connector._run_blocking(blocking_func, 21)
        end = asyncio.get_running_loop().time()
        
        self.assertEqual(res, 42)
        self.assertTrue(end - start >= 0.1)

    async def test_source_models(self):
        item = SourceItem(id="test:1", name="foo", type="file")
        self.assertEqual(item.id, "test:1")
        self.assertEqual(item.size, 0)
        
        content = SourceContent(id="test:1", name="foo", type="file", text="bar")
        self.assertEqual(content.text, "bar")

class TestGithubConnector(unittest.IsolatedAsyncioTestCase):
    async def test_list_items(self):
        # Mock the github module and Github class
        mock_gh_instance = MagicMock()
        mock_repo = MagicMock()
        mock_gh_instance.get_repo.return_value = mock_repo
        
        # Mock ContentFile
        mock_content = MagicMock()
        mock_content.path = "README.md"
        mock_content.name = "README.md"
        mock_content.type = "file"
        mock_content.encoding = "base64"
        mock_content.size = 100
        mock_content.sha = "123"
        
        mock_repo.get_contents.return_value = [mock_content]

        connector = github_connector("test_user")
        connector.token = "fake_token"
        connector.github = mock_gh_instance
        connector._connected = True
        
        # We need to mock _run_blocking to just execute the function
        # because the internal function inside list_items is structured as a closure
        # that uses self.github.
        async def mock_run_blocking(func, *args, **kwargs):
            return func(*args, **kwargs)
            
        connector._run_blocking = mock_run_blocking
        
        # Act
        items = await connector.list_items(repo="owner/repo")
        
        # Assert
        self.assertEqual(len(items), 1)
        self.assertIsInstance(items[0], SourceItem)
        self.assertEqual(items[0].id, "owner/repo:README.md")
        self.assertEqual(items[0].name, "README.md")

    async def test_fetch_item(self):
        mock_gh_instance = MagicMock()
        mock_repo = MagicMock()
        mock_gh_instance.get_repo.return_value = mock_repo
        
        mock_content = MagicMock()
        mock_content.path = "README.md"
        mock_content.name = "README.md"
        mock_content.encoding = "base64"
        mock_content.decoded_content = b"Content"
        mock_content.size = 7
        mock_content.sha = "abc"
        
        mock_repo.get_contents.return_value = mock_content
        
        connector = github_connector("test_user")
        connector.github = mock_gh_instance
        connector._connected = True
        
        async def mock_run_blocking(func, *args, **kwargs):
            return func(*args, **kwargs)
            
        connector._run_blocking = mock_run_blocking
        
        content = await connector.fetch_item("owner/repo:README.md")
        
        self.assertIsInstance(content, SourceContent)
        self.assertEqual(content.text, "Content")

class TestNotionConnector(unittest.IsolatedAsyncioTestCase):
    async def test_list_items(self):
        # Use AsyncMock for async client methods
        from unittest.mock import AsyncMock
        mock_client = AsyncMock()
        
        # Mock database query response
        mock_client.search.return_value = {
            "results": [{
                "id": "page-1",
                "url": "https://notion.so/page-1",
                "last_edited_time": "2023-01-01",
                "properties": {
                    "Name": {
                        "type": "title",
                        "title": [{"plain_text": "Test Page"}]
                    }
                },
                "object": "page"
            }],
            "has_more": False
        }
        # In case it uses databases.query instead of search
        mock_client.databases.query.return_value = {
            "results": [{
                "id": "page-1",
                "url": "https://notion.so/page-1",
                "last_edited_time": "2023-01-01",
                "properties": {
                    "Name": {
                        "type": "title",
                        "title": [{"plain_text": "Test Page"}]
                    }
                },
                "object": "page"
            }],
            "has_more": False
        }
        
        connector = notion_connector("test_user")
        connector.client = mock_client
        connector._connected = True
        
        # Mock blocking runner
        async def mock_run_blocking(func, *args, **kwargs):
            return func(*args, **kwargs)
        connector._run_blocking = mock_run_blocking
        
        items = await connector.list_items(database_id="db-1")
        
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].id, "page-1")
        self.assertEqual(items[0].name, "Test Page")

if __name__ == "__main__":
    unittest.main()
