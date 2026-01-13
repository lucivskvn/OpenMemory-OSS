import unittest
import openmemory  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.client import OpenMemory, Memory, Client  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.core.types import MemoryItem  # type: ignore[import-untyped]  # type: ignore[import-untyped]

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
            primarySector="semantic",
            createdAt=1,
            updatedAt=1,
            lastSeenAt=1,
            tags=[],
            meta={},
            sectors=[],
            feedbackScore=0.0,
        )
        self.assertEqual(item.content, "test")

if __name__ == "__main__":
    unittest.main()
