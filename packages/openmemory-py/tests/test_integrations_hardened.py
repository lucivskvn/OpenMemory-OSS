import unittest
import asyncio
from unittest.mock import MagicMock, patch, AsyncMock
import sys

# Mock LangChain for the test environment
mock_lc = MagicMock()
class MockDoc:
    def __init__(self, page_content, metadata=None):
        self.page_content = page_content
        self.metadata = metadata or {}
    def model_dump(self):
        return self.metadata

mock_lc.Document = MockDoc
from pydantic import BaseModel
mock_lc.BaseRetriever = BaseModel
mock_lc.BaseChatMessageHistory = object

sys.modules["langchain_core"] = mock_lc
sys.modules["langchain_core.chat_history"] = mock_lc
sys.modules["langchain_core.messages"] = mock_lc
sys.modules["langchain_core.retrievers"] = mock_lc
sys.modules["langchain_core.documents"] = mock_lc
sys.modules["langchain_core.callbacks"] = mock_lc

from openmemory.client import Client, OpenMemory  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.core.types import MemoryItem  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.integrations.agents import CrewAIMemory  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.integrations.langchain import OpenMemoryChatMessageHistory, OpenMemoryRetriever  # type: ignore[import-untyped]  # type: ignore[import-untyped]

class TestPhase63(unittest.IsolatedAsyncioTestCase):
    async def test_client_aliases(self):
        self.assertEqual(Client, OpenMemory)
        mem = Client()
        self.assertIsInstance(mem, Client)

    @patch("openmemory.main.ingest_document")
    @patch("openmemory.main.q.get_mem")
    async def test_memory_add_returns_item(self, mock_get_mem, mock_ingest):
        # Mock ingest_document
        mock_ingest.return_value = {"root_memory_id": "test_id"}
        # Mock q.get_mem (called by self.get)
        # Note: self.get() decrypts content, so we need bytes
        from openmemory.core.security import get_encryption  # type: ignore[import-untyped]
        enc = get_encryption()
        mock_get_mem.return_value = {
            "id": "test_id",
            "content": enc.encrypt("test content"),
            "primary_sector": "semantic",
            "created_at": 123,
            "updated_at": 123,
            "last_seen_at": 123,
            "salience": 1.0,
            "tags": "[]",
            "metadata": "{}",
            "user_id": "test_user",
            "decay_lambda": 0.02,
            "version": 1,
            "segment": 0,
            "simhash": None,
            "generated_summary": None,
            "feedback_score": 0.0
        }

        mem = Client(user="test_user")
        item = await mem.add("test content")

        self.assertIsInstance(item, MemoryItem)
        self.assertEqual(item["id"], "test_id")
        self.assertEqual(item["content"], "test content")

    async def test_crewai_adapter_sync_bridge(self):
        mock_mem = AsyncMock()
        mock_mem.search.return_value = [
            MemoryItem(
                id="1",
                content="res",
                primarySector="s",
                createdAt=0,
                updatedAt=0,
                lastSeenAt=0,
                sectors=[],
                tags=[],
                meta={},
                salience=0.0,
                feedbackScore=0.0,
            )
        ]

        adapter = CrewAIMemory(mock_mem, user_id="crew_user")

        # Test save (sync)
        # Running in a thread to simulate sync usage and avoid deadlock with the test loop
        await asyncio.to_thread(adapter.save, "hello")
        await asyncio.sleep(0.1) # wait for task
        mock_mem.add.assert_called()

        # Test search (sync)
        res = await asyncio.to_thread(adapter.search, "query")
        self.assertEqual(res, ["res"])

    async def test_langchain_retriever_bridge(self):
        from openmemory.integrations.langchain import OpenMemoryRetriever
        from unittest.mock import MagicMock

        mock_mem = AsyncMock()
        mock_mem.search.return_value = [
            MemoryItem(
                id="1",
                content="res",
                primarySector="s",
                createdAt=0,
                updatedAt=0,
                lastSeenAt=0,
                sectors=[],
                tags=[],
                meta={},
                salience=0.0,
                feedbackScore=0.0,
            )
        ]

        retriever = OpenMemoryRetriever(memory=mock_mem, user_id="lc_user", k=5)

        # Test sync bridge in thread
        docs = await asyncio.to_thread(
            retriever._get_relevant_documents, "q", run_manager=MagicMock()
        )
        self.assertEqual(docs[0].page_content, "res")

        # Test async
        docs_async = await retriever._aget_relevant_documents(
            "q", run_manager=MagicMock()
        )
        self.assertEqual(docs_async[0].page_content, "res")

if __name__ == '__main__':
    unittest.main()
