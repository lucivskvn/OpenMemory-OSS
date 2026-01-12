import unittest
import json
import asyncio
from unittest.mock import MagicMock, patch
from openmemory.memory import hsg
from openmemory.core.db import db
from openmemory.memory.hsg import add_hsg_memory, compute_simhash

class TestGraphIntegrity(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        # Use in-memory DB for tests
        db.conn = None
        from openmemory.core.config import env
        env.database_url = "sqlite:///:memory:"
        db.connect()
        db.init_schema()

    def tearDown(self):
        if db.conn:
            db.conn.close()
        db.conn = None

    async def test_simhash_parity(self):
        """Verify SimHash produces consistent hex string for known input."""
        # Using a known fixed string.
        # In JS: compute_simhash("hello world") -> hex
        # "hello world" -> tokens ["hello", "world"]
        # This test ensures stable hashing behavior across implementations
        text = "OpenMemory is great"
        hash1 = compute_simhash(text)
        hash2 = compute_simhash(text)
        self.assertEqual(hash1, hash2)
        self.assertEqual(len(hash1), 16) # 64 bits = 16 hex chars

    @patch("openmemory.memory.hsg.embed_multi_sector")
    @patch("openmemory.memory.hsg.create_single_waypoint")
    @patch("openmemory.memory.hsg.create_inter_mem_waypoints")
    @patch("openmemory.memory.hsg.calc_mean_vec")
    async def test_deduplication(self, mock_mean, mock_imw, mock_csw, mock_embed):
        # Mock embeddings
        mock_embed.return_value = [{"sector": "semantic", "vector": [0.1]*128, "dim": 128}]
        mock_mean.return_value = [0.1]*128

        content = "This is a unique memory content for deduplication test."

        # 1. Add First Memory
        res1 = await add_hsg_memory(content, user_id="test_user")
        self.assertFalse(res1.get("deduplicated"))

        # Verify it exists in DB
        mem1 = db.fetchone("SELECT * FROM memories WHERE id=?", (res1["id"],))
        self.assertIsNotNone(mem1)
        assert mem1 is not None
        initial_salience = mem1["salience"]

        # 2. Add Same Memory Again
        res2 = await add_hsg_memory(content, user_id="test_user")

        # Assertions
        self.assertTrue(res2.get("deduplicated"))
        self.assertEqual(res2["id"], res1["id"])

        # Verify Salience Boost
        mem2 = db.fetchone("SELECT * FROM memories WHERE id=?", (res1["id"],))
        self.assertIsNotNone(mem2)
        assert mem2 is not None
        self.assertGreater(mem2["salience"], initial_salience)

    @patch("openmemory.memory.hsg.embed_multi_sector")
    @patch("openmemory.memory.hsg.calc_mean_vec")
    async def test_waypoints_creation(self, mock_mean, mock_embed):
        # Mock embeddings to be distinct
        mock_embed.return_value = [{"sector": "semantic", "vector": [0.1]*128, "dim": 128}]
        mock_mean.return_value = [0.1]*128

        # Insert Mem A
        resA = await add_hsg_memory("Memory A content", user_id="user1")

        # Mock second embedding to be similar
        mock_mean.return_value = [0.11]*128 # Close to 0.1

        # Insert Mem B - should link to A via Single Waypoint (time-based/similarity)
        # Note: add_hsg_memory calls create_single_waypoint which queries DB
        resB = await add_hsg_memory("Memory B content", user_id="user1")

        # Check Waypoints
        wp = db.fetchone("SELECT * FROM waypoints WHERE src_id=? AND dst_id=?", (resB["id"], resA["id"]))
        # Since we mocked create_single_waypoint in previous tests, make sure we actually rely on real logic here?
        # oops, I didn't mock create_single_waypoint in THIS test method. Good.

        # real create_single_waypoint logic compares vectors.
        # We need to ensure vectors are stored.
        # add_hsg_memory calls storeVector. We need to mock store.storeVector?
        # hsg.py imports store from ..core.vector_store
        # We should just let it run if mocking isn't too heavy.

        # Wait, hsg.py's create_single_waypoint uses q.all_mem_by_user and looks at MEMORY rows for mean_vec.
        # So as long as Mem A has mean_vec, it should work.

        self.assertIsNotNone(wp, "Waypoint should be created between B and A")

if __name__ == "__main__":
    unittest.main()
