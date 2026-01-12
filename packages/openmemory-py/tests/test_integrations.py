import unittest
import asyncio
from unittest.mock import MagicMock, AsyncMock, patch
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../src")))

from openmemory.utils.async_bridge import run_sync  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.integrations.agents import CrewAIMemory  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.integrations.langchain import OpenMemoryChatMessageHistory  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.core.types import MemoryItem  # type: ignore[import-untyped]  # type: ignore[import-untyped]

class TestAsyncBridge(unittest.TestCase):
    def test_run_sync_simple(self):
        async def simple_coro():
            return "success"
        
        res = run_sync(simple_coro())
        self.assertEqual(res, "success")

class TestIntegrations(unittest.TestCase):
    def setUp(self):
        self.mock_mem = MagicMock()
        # Mock add to be an async mock
        self.mock_mem.add = AsyncMock()
        self.mock_mem.search = AsyncMock()
        self.mock_mem.history = AsyncMock()

    def test_crewai_save(self):
        adapter = CrewAIMemory(self.mock_mem, user_id="test_agent")
        adapter.save("test content")

        # Verify add was awaited
        self.mock_mem.add.assert_called_once()
        args, kwargs = self.mock_mem.add.call_args
        self.assertEqual(args[0], "test content")
        self.assertEqual(kwargs["user_id"], "test_agent")

    def test_langchain_messages_sync_property(self):
        # Setup mock history return
        item1 = MemoryItem(
            id="1",
            content="User: Hello",
            created_at=1,
            updated_at=1,
            last_seen_at=1,
            primary_sector="semantic",
            sectors=["semantic"],
            tags=[],
            metadata={},
            salience=0.5,
            user_id="u1",
            feedback_score=0,
            _debug=None,
        )
        item2 = MemoryItem(
            id="2",
            content="Assistant: Hi",
            created_at=2,
            updated_at=2,
            last_seen_at=2,
            primary_sector="semantic",
            sectors=["semantic"],
            tags=[],
            metadata={},
            salience=0.5,
            user_id="u1",
            feedback_score=0,
            _debug=None,
        )

        self.mock_mem.history.return_value = [item1, item2] 

        history = OpenMemoryChatMessageHistory(self.mock_mem, user_id="u1")

        # Accessing .messages property which calls run_sync -> invokes history()
        # We replaced the try-except in src with "silent catch" returning [], so we might not see the error from here.
        # But we can patch logger if there was one? No logger there.
        # The code in langchain.py:
        # try: ... except: return []

        # I should test run_sync directly with the mock to see if it fails.
        try:
            res = run_sync(self.mock_mem.history("u1"))
            print(f"DIRECT RUN_SYNC RESULT: {res}")
        except Exception as e:
            print(f"DIRECT RUN_SYNC ERROR: {e}")
            import traceback
            traceback.print_exc()

        msgs = history.messages
        # If len is 0, print that failed
        if len(msgs) == 0:
            print("History messages returned empty list.")

        self.assertEqual(len(msgs), 2)
        self.assertEqual(msgs[0].content, "Hello")
        self.assertEqual(msgs[1].content, "Hi")

if __name__ == "__main__":
    unittest.main()
