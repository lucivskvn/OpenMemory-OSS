
import unittest
import asyncio
from openmemory.main import Memory  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.core.db import db  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.core.config import env  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from unittest.mock import AsyncMock, patch, Mock

class TestTemporalGraph(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # Force close previous connection if any
        if db.conn:
            try:
                db.conn.close()
            except:
                pass
            db.conn = None
            
        # Setup in-memory DB
        env.db_path = ":memory:"
        db.connect()
        
        # We need a user
        self.user_id = "test_user_temporal"
        self.mem = Memory(user=self.user_id)

    async def asyncTearDown(self):
        if db.conn:
            try:
                db.conn.close()
            except:
                pass
            db.conn = None

    async def test_temporal_flow(self):
        # 1. Create Facts
        t = self.mem.temporal
        f1_id = await t.add("Entity:1", "is_a", "TestEntity", confidence=0.9)
        self.assertIsNotNone(f1_id)
        
        f2_id = await t.add("Entity:2", "is_a", "TestEntity")
        
        # 2. Query Facts
        facts = await t.search("Entity")
        self.assertTrue(len(facts) >= 2)
        
        # 3. Create Edge
        e1_id = await t.add_edge(f1_id, f2_id, "related_to", weight=0.8)
        self.assertIsNotNone(e1_id)
        
        # 4. Query Edges
        related = await t.get_edges(source_id=f1_id)
        self.assertEqual(len(related), 1)
        self.assertEqual(related[0]["fact"]["id"], f2_id)
        self.assertEqual(related[0]["relation"], "related_to")
        
        # 5. History
        hist = await t.history("Entity:1")
        self.assertTrue(len(hist) >= 1)

    async def test_delete_fact_atomicity(self):
        """Verify that delete_fact uses a transaction."""
        from openmemory.temporal_graph.store import delete_fact  # type: ignore[import-untyped]
        
        with patch("openmemory.temporal_graph.store.db", new_callable=Mock) as mock_db:
            mock_db.transaction.return_value.__aenter__ = AsyncMock()
            mock_db.transaction.return_value.__aexit__ = AsyncMock()
            mock_db.async_execute = AsyncMock()
            
            await delete_fact("f1", self.user_id)
            
            self.assertTrue(mock_db.transaction.called)
            self.assertEqual(mock_db.async_execute.call_count, 2)

    async def test_get_related_facts_logic(self):
        """Verify get_related_facts query structure."""
        from openmemory.temporal_graph.query import get_related_facts  # type: ignore[import-untyped]
        
        with patch("openmemory.temporal_graph.query.db", new_callable=AsyncMock) as mock_db:
            mock_db.async_fetchall.return_value = [
                {
                    "id": "f2", "user_id": self.user_id, "subject": "S2", "predicate": "P2", "object": "O2",
                    "valid_from": 1000, "valid_to": None, "confidence": 0.9, "last_updated": 1000,
                    "metadata": None, "relation_type": "causes", "weight": 0.8, "edge_user_id": self.user_id
                }
            ]
            
            res = await get_related_facts("f1", user_id=self.user_id)
            self.assertEqual(len(res), 1)
            self.assertEqual(res[0]["fact"]["id"], "f2")
            self.assertEqual(res[0]["fact"]["id"], "f2")
            self.assertEqual(res[0]["relation"], "causes")

    async def test_batch_insert(self):
        """Verify batch_insert_facts atomic behavior."""
        from openmemory.temporal_graph.store import batch_insert_facts  # type: ignore[import-untyped]
        
        facts = [
            {"subject": "S_B1", "predicate": "P_B1", "object": "O_B1"},
            {"subject": "S_B2", "predicate": "P_B2", "object": "O_B2"}
        ]
        
        ids = await batch_insert_facts(facts, user_id=self.user_id)
        self.assertEqual(len(ids), 2)
        
        # Verify persistence
        t = self.mem.temporal
        hits = await t.search("S_B")
        self.assertEqual(len(hits), 2)

if __name__ == '__main__':
    unittest.main()
