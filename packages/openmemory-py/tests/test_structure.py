import unittest
import openmemory
from openmemory.client import OpenMemory, Memory, Client
from openmemory.core.types import MemoryItem

class TestStructure(unittest.TestCase):
    def test_version_exposed(self):
        # Version should be string
        self.assertIsInstance(openmemory.__version__, str)
        self.assertEqual(openmemory.__version__, "2.3.0")

    def test_exports(self):
        # Aliases should check out
        self.assertIs(OpenMemory, Memory)
        self.assertIs(Client, Memory)

        # Types should be importable
        # Just checking if we can instantiate one roughly
        item = MemoryItem(
            id="test",
            content="test",
            primary_sector="semantic",
            created_at=1,
            updated_at=1,
            last_seen_at=1,
            tags=[],
            meta={},
            sectors=[],
            feedback_score=0.0,
            _debug=None,
        )
        self.assertEqual(item.content, "test")

if __name__ == "__main__":
    unittest.main()
