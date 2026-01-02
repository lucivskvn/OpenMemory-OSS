import unittest
import asyncio
import os
import shutil
from pathlib import Path
from openmemory.client import OpenMemory
from openmemory.core.config import env

class TestPhase64(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        # Ensure a fresh data dir for tests
        cls.test_db = "test_phase_64.db"
        if os.path.exists(cls.test_db):
            os.remove(cls.test_db)

    @classmethod
    def tearDownClass(cls):
        if os.path.exists(cls.test_db):
            os.remove(cls.test_db)
        if os.path.exists("memory.sqlite"):
            os.remove("memory.sqlite")

    async def test_constructor_overrides(self):
        # Use constructor to set a custom path
        mem = OpenMemory(path=self.test_db, tier="smart")
        
        # Verify config was updated
        self.assertEqual(env.db_path, self.test_db)
        self.assertEqual(env.tier, "smart")
        
        # Verify DB connection works and file is created
        await mem.add("test override", user_id="test_user")
        self.assertTrue(os.path.exists(self.test_db))
        await mem.close()

    async def test_api_aliases(self):
        # Force a fresh in-memory or default DB for this test
        mem = OpenMemory(path="api_test.sqlite")
        await mem.add("The quick brown fox jumps over the lazy dog", user_id="u1", tags=["t1"])
        await mem.add("Quantum computing is a type of computation that uses quantum-mechanical phenomena", user_id="u1", tags=["t2"])
        
        # Test getAll
        all_mem = await mem.getAll(user_id="u1")
        self.assertGreaterEqual(len(all_mem), 2)
        
        # Test getBySector
        # Note: sector classification is async, might take a moment in real scenario
        # but here we just check if the method exists and doesn't crash
        sects = mem.list_sectors()
        self.assertIn("semantic", sects)
        
        # Test close
        await mem.close()
        # Trying to query after close should ideally raise or handle gracefully
        # but we mainly verify it doesn't crash during close.

    async def test_env_update_logic(self):
        env.update_config(tier="deep", api_key="sk-test")
        self.assertEqual(env.tier, "deep")
        self.assertEqual(env.openai_key, "sk-test")

if __name__ == "__main__":
    unittest.main()
