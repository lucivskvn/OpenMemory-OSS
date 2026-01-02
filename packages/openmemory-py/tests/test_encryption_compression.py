
import unittest
import os
import shutil
import base64
import json
import struct
from openmemory.core.security import get_encryption
from openmemory.utils.vectors import compress_vec_for_storage, vec_to_buf, buf_to_vec
from openmemory.main import Memory
from openmemory.core.db import db
from openmemory.core.config import env

class TestEncryptionCompression(unittest.TestCase):
    def setUp(self):
        env.db_path = ":memory:"
        db.connect()
        # Enable encryption for this test
        os.environ["OM_ENCRYPTION_ENABLED"] = "true"
        # 32-byte key for AES-256
        self.key = "12345678901234567890123456789012" 
        os.environ["OM_ENCRYPTION_KEY"] = self.key
        
        # Reset singleton to pick up new env vars
        from openmemory.core import security
        security._instance = None
        
        self.provider = get_encryption()
        self.mem = Memory(user="test_enc_user")

    def tearDown(self):
        try:
            db.close()
        except:
            pass
        os.environ.pop("OM_ENCRYPTION_ENABLED", None)
        os.environ.pop("OM_ENCRYPTION_KEY", None)

    def test_encryption_roundtrip(self):
        plain = "Secret Message 🚀"
        encrypted = self.provider.encrypt(plain)
        
        self.assertNotEqual(plain, encrypted)
        self.assertTrue(encrypted.startswith("enc:"))
        
        decrypted = self.provider.decrypt(encrypted)
        self.assertEqual(plain, decrypted)

    def test_encryption_integration(self):
        # Verify that memory stored is encrypted in DB but decrypted on retrieval
        content = "My super secret memory"
        async def run():
            res = await self.mem.add(content)
            mid = res["id"]
            
            # Direct DB check
            row = db.fetchone("SELECT content FROM memories WHERE id=?", (mid,))
            raw_content = row["content"]
            self.assertNotEqual(content, raw_content)
            self.assertTrue(raw_content.startswith("enc:"))
            
            # API Retrieval check
            m = await self.mem.get(mid)
            self.assertEqual(m.content, content)
            
        import asyncio
        asyncio.run(run())

    def test_compression_logic(self):
        # Test vector compression (dimension reduction/quantization logic)
        # Create a 10-dim vector
        vec = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
        # Target 5 dims
        target_dim = 5
        
        compressed = compress_vec_for_storage(vec, target_dim)
        self.assertEqual(len(compressed), 5)
        
        # Check logic: bucket size = 2. 
        # 0: (1+2)/2 = 1.5
        # 1: (3+4)/2 = 3.5
        # 2: (5+6)/2 = 5.5
        # ...
        # Then normalized. 
        # Raw averaged: [1.5, 3.5, 5.5, 7.5, 9.5]
        # Norm = sqrt(1.5^2 + ... + 9.5^2)
        
        import math
        raw = [1.5, 3.5, 5.5, 7.5, 9.5]
        norm = math.sqrt(sum(x*x for x in raw))
        expected = [x/norm for x in raw]
        
        for i in range(5):
            self.assertAlmostEqual(compressed[i], expected[i], places=5)
            
    def test_buffer_conversion(self):
        vec = [1.1, 2.2, 3.3]
        buf = vec_to_buf(vec)
        self.assertEqual(len(buf), 12) # 3 * 4 bytes
        
        vec2 = buf_to_vec(buf)
        for i in range(3):
            self.assertAlmostEqual(vec[i], vec2[i], places=5)

    def test_compression_facade(self):
        # Verify Memory class exposes compression engine
        self.assertIsNotNone(self.mem.compression)
        self.assertTrue(hasattr(self.mem.compression, "compress"))
        stats = self.mem.compression.get_stats()
        self.assertIn("total", stats)


if __name__ == '__main__':
    unittest.main()
