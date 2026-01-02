import os
import base64
import logging
from typing import Optional, Any
import hashlib

# Try importing cryptography
try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False

logger = logging.getLogger("security")

class EncryptionProvider:
    def __init__(self):
        self.secret = os.getenv("OM_ENCRYPTION_KEY") or os.getenv("OM_API_KEY")
        self.enabled = os.getenv("OM_ENCRYPTION_ENABLED", "false").lower() == "true"
        self._aes: Optional[Any] = None

        if self.enabled:
            if not HAS_CRYPTO:
                logger.warning("[Security] OM_ENCRYPTION_ENABLED=true but 'cryptography' package is missing. Encryption disabled.")
                self.enabled = False
                return
                
            if not self.secret or len(self.secret) < 16:
                logger.warning("[Security] Encryption enabled but key is too short (<16 chars) or missing. Encryption disabled.")
                self.enabled = False
                return

            try:
                # Key Derivation (Parity with JS: PBKDF2, salt='openmemory-salt-v1', iter=100000, sha256)
                kdf = PBKDF2HMAC(
                    algorithm=hashes.SHA256(),
                    length=32,
                    salt=b"openmemory-salt-v1",
                    iterations=100000,
                )
                key_material = self.secret.encode("utf-8")
                key = kdf.derive(key_material)
                self._aes = AESGCM(key)
                logger.info("[Security] 🔒 Encryption-at-Rest ENABLED (AES-256-GCM / PBKDF2)")
            except Exception as e:
                logger.error(f"[Security] Key derivation failed: {e}")
                self.enabled = False

    def encrypt(self, text: str) -> str:
        if not self.enabled or not self._aes:
            return text
            
        try:
            iv = os.urandom(12) # 96-bit IV
            data = text.encode("utf-8")
            ct = self._aes.encrypt(iv, data, None)
            
            # Format: enc:{iv_b64}:{ct_b64}
            iv_b64 = base64.b64encode(iv).decode("ascii")
            ct_b64 = base64.b64encode(ct).decode("ascii")
            return f"enc:{iv_b64}:{ct_b64}"
            
        except Exception as e:
            logger.error(f"[Security] Encryption failed: {e}")
            # Fallback to plaintext or re-raise? JS throws?
            # Ideally we shouldn't fail silent on encryption intent.
            raise e

    def decrypt(self, text: str) -> str:
        if not text or not text.startswith("enc:"):
            return text
            
        if not self.enabled or not self._aes:
            return text # Cannot decrypt
            
        try:
            parts = text.split(":")
            if len(parts) != 3:
                return text 
                
            iv_b64 = parts[1]
            ct_b64 = parts[2]
            
            iv = base64.b64decode(iv_b64)
            ct = base64.b64decode(ct_b64)
            
            pt_bytes = self._aes.decrypt(iv, ct, None)
            return pt_bytes.decode("utf-8")
            
        except Exception as e:
            logger.error(f"[Security] Decryption failed: {e}")
            # In severe cases, this might mean data corruption or wrong key.
            # Return text as-is allows caller to see the ciphertext (better than crash, but useless data)
            raise ValueError("Decryption failed")

# Singleton
_instance = None

def get_encryption() -> EncryptionProvider:
    global _instance
    if not _instance:
        _instance = EncryptionProvider()
    return _instance
