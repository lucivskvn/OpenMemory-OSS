"""
Audited: 2026-01-19
Encryption-at-rest module using AES-256-GCM via PBKDF2 key derivation.
"""
import os
import base64
import logging
import time
from typing import Optional, Any
import hashlib
from fastapi import HTTPException, Request

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
        from .config import env
        self.secret = env.encryption_key
        self.secondary_secrets = env.encryption_secondary_keys
        self.salt = env.encryption_salt.encode("utf-8")
        self.enabled = env.encryption_enabled
        self._key_cache = {}

        if self.enabled:
            # ... rest of init ...
            if not HAS_CRYPTO:
                logger.warning("[Security] OM_ENCRYPTION_ENABLED=true but 'cryptography' package is missing. Encryption disabled.")
                self.enabled = False
                return

            if not self.secret or len(self.secret) < 16:
                logger.warning("[Security] Encryption enabled but key is too short (<16 chars) or missing. Encryption disabled.")
                self.enabled = False
                return

            # Verify primary key works
            if not self.verify_key():
                logger.error("[Security] Key verification failed. Encryption disabled.")
                self.enabled = False

    def _get_aes(self, secret: str) -> Optional[Any]:
        if secret in self._key_cache:
            return self._key_cache[secret]

        try:
            from cryptography.hazmat.primitives import hashes as h
            from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC as KDF
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM as AES

            kdf = KDF(
                algorithm=h.SHA256(),
                length=32,
                salt=self.salt,
                iterations=600000,
            )
            key = kdf.derive(secret.encode("utf-8"))
            aes = AES(key)
            self._key_cache[secret] = aes
            return aes
        except Exception as e:
            logger.error(f"[Security] Key derivation failed: {e}")
            return None

    def encrypt(self, text: str) -> str:
        if not self.enabled or not self.secret:
            return text

        aes = self._get_aes(self.secret)
        if not aes: return text

        try:
            iv = os.urandom(12) # 96-bit IV
            data = text.encode("utf-8")
            ct = aes.encrypt(iv, data, None)

            # Format: v1:{iv_b64}:{ct_b64} (JS parity)
            iv_b64 = base64.b64encode(iv).decode("ascii")
            ct_b64 = base64.b64encode(ct).decode("ascii")
            return f"v1:{iv_b64}:{ct_b64}"

        except Exception as e:
            logger.error(f"[Security] Encryption failed: {e}")
            raise e

    def decrypt(self, text: str) -> str:
        if not text or not (text.startswith("enc:") or text.startswith("v1:")):
            return text

        if not self.enabled:
            return text # Cannot decrypt

        all_secrets = [self.secret] + (self.secondary_secrets or [])

        parts = text.split(":")
        if len(parts) != 3:
            return text

        iv_b64 = parts[1]
        ct_b64 = parts[2]

        try:
            iv = base64.b64decode(iv_b64)
            ct = base64.b64decode(ct_b64)
        except Exception:
            return text

        for secret in all_secrets:
            if not secret: continue
            aes = self._get_aes(secret)
            if not aes: continue

            try:
                pt_bytes = aes.decrypt(iv, ct, None)
                return pt_bytes.decode("utf-8")
            except Exception:
                # Try next secret
                continue

        logger.error("[Security] Decryption failed with all available keys.")
        raise ValueError("Decryption failed")

    def re_encrypt(self, text: str) -> str:
        """
        Decrypt with any valid key and re-encrypt with the primary key.
        Useful for key rotation.
        """
        if not self.enabled or not self.secret:
            return text

        # If not encrypted, don't touch
        if not text or not (text.startswith("enc:") or text.startswith("v1:")):
            return text

        try:
            decrypted = self.decrypt(text)
            return self.encrypt(decrypted)
        except Exception:
            # If decryption fails, return original (maybe it wasn't valid)
            return text

    def verify_key(self) -> bool:
        """Verify the primary key works correctly."""
        if not self.secret: return False
        try:
            test_val = f"om_sec_test_{int(time.time())}"
            # Temporarily force enabled for test if needed, but here we assume caller wants verification
            orig_enabled = self.enabled
            self.enabled = True
            try:
                enc = self.encrypt(test_val)
                dec = self.decrypt(enc)
                return dec == test_val
            finally:
                self.enabled = orig_enabled
        except Exception as e:
            logger.error(f"[Security] Key verification check failed: {e}")
            return False

# Singleton
_instance = None

def get_encryption() -> EncryptionProvider:
    global _instance
    if not _instance:
        _instance = EncryptionProvider()
    return _instance
