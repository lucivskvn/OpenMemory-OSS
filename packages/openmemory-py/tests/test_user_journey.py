
import unittest
import asyncio
from openmemory.ops.ingest import ingest_document
from openmemory.main import Memory
from openmemory.core.db import db, q

class TestUserJourney(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from openmemory.core.config import env
        env.db_path = ":memory:"
        # Force reconnection to use new path
        db.connect(force=True)
        
    async def asyncTearDown(self):
        try:
            db.close()
        except:
            pass
            
    async def test_ingest_ownership_explicit(self):
        # Simulate corrected VSCode client behavior (explicit top-level user_id)
        res = await ingest_document(
            "text", 
            "Explicit User Content", 
            user_id="user_explicit",
            meta={"origin": "test"}
        )
        mid = res["root_memory_id"]
        
        # Verify DB ownership
        mem = await q.get_mem(mid)
        self.assertIsNotNone(mem)
        self.assertEqual(mem["user_id"], "user_explicit")
        
    async def test_ingest_ownership_fallback(self):
        # Simulate legacy/buggy client behavior (nested user_id) to test fallback
        res = await ingest_document(
            "text", 
            "Fallback User Content", 
            user_id=None,
            meta={"origin": "test", "user_id": "user_fallback"}
        )
        mid = res["root_memory_id"]
        
        # Verify DB ownership via fallback logic
        mem = await q.get_mem(mid)
        self.assertIsNotNone(mem)
        self.assertEqual(mem["user_id"], "user_fallback")

    async def test_ingest_ownership_anonymous(self):
        # Simulate truly anonymous
        res = await ingest_document(
            "text", 
            "Anon Content", 
            user_id=None,
            meta={"origin": "test"}
        )
        mid = res["root_memory_id"]
        
        mem = await q.get_mem(mid)
        self.assertIsNotNone(mem)
        self.assertEqual(mem["user_id"], "anonymous")

if __name__ == "__main__":
    unittest.main()
