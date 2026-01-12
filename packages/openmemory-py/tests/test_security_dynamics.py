import pytest
import asyncio
from unittest.mock import MagicMock, patch
from openmemory.core.security import EncryptionProvider
from openmemory.server.dependencies import verify_admin
from openmemory.ops import dynamics
from fastapi import Request, HTTPException

# === Security Tests ===

def test_re_encrypt_rotation():
    """Verify that re_encrypt correctly rotates keys."""
    # Setup mock env with primary + secondary keys
    with patch("openmemory.core.config.env") as mock_env:
        mock_env.encryption_key = "primary_secret_key_must_be_long_enough" # 32+ chars
        mock_env.encryption_secondary_keys = ["old_secret_key_must_be_long_enough"]
        mock_env.encryption_enabled = True
        
        provider = EncryptionProvider()
        
        # Manually encrypt with OLD key
        # We cheat by temporarily setting primary to old, encrypting, then switching back
        provider.secret = "old_secret_key_must_be_long_enough"
        provider._key_cache.clear()
        
        original_text = "Sensitive Data for Rotation"
        old_encrypted = provider.encrypt(original_text)
        
        # Verify it uses the old key (different IV each time, but we trust encrypt)
        assert old_encrypted.startswith("v1:")
        
        # Switch to NEW primary
        provider.secret = "primary_secret_key_must_be_long_enough"
        provider.secondary_secrets = ["old_secret_key_must_be_long_enough"]
        provider._key_cache.clear()
        
        # Attempt Re-encrypt
        rotated = provider.re_encrypt(old_encrypted)
        
        assert rotated != old_encrypted
        assert rotated.startswith("v1:")
        
        # Decrypt with NEW configuration (should work for both, but rotated is now native)
        decrypted = provider.decrypt(rotated)
        assert decrypted == original_text

def test_verify_admin_logic():
    """Verify RBAC enforcement."""
    # 1. Admin Role -> Pass
    req_admin = MagicMock(spec=Request)
    req_admin.state.user_id = "user_123"
    req_admin.state.role = "admin"
    assert verify_admin(req_admin) is None # Should return None (void)
    
    # 2. Master Key -> Pass
    req_master = MagicMock(spec=Request)
    req_master.state.user_id = "default-user"
    req_master.state.role = "admin"
    assert verify_admin(req_master) is None
    
    # 3. User Role -> Fail
    req_user = MagicMock(spec=Request)
    req_user.state.user_id = "user_456"
    req_user.state.role = "user"
    
    with pytest.raises(HTTPException) as exc:
        verify_admin(req_user)
    assert exc.value.status_code == 403

# === Dynamics Tests ===

@pytest.mark.asyncio
async def test_trace_reinforcement():
    """Verify learning curve math."""
    initial_salience = 0.5
    # Formula: s + 0.18 * (1 - s) = 0.5 + 0.18 * 0.5 = 0.5 + 0.09 = 0.59
    new_sal = await dynamics.applyRetrievalTraceReinforcementToMemory("mem_1", initial_salience)
    assert abs(new_sal - 0.59) < 0.001
    
    # Max cap
    high_sal = 0.95
    # 0.95 + 0.18 * 0.05 = 0.95 + 0.009 = 0.959
    new_high = await dynamics.applyRetrievalTraceReinforcementToMemory("mem_2", high_sal)
    assert new_high <= 1.0

@pytest.mark.asyncio
async def test_cross_sector_resonance():
    """Verify sector interdependence matrix lookup."""
    # Episodic -> Semantic (0 -> 1) value is 0.7
    score = await dynamics.calculateCrossSectorResonanceScore("episodic", "semantic", 1.0)
    assert abs(score - 0.7) < 0.001
    
    # Semantic -> Procedural (1 -> 2) value is 0.4
    score2 = await dynamics.calculateCrossSectorResonanceScore("semantic", "procedural", 1.0)
    assert abs(score2 - 0.4) < 0.001
    
    # Unknown sector fallback (identity or default?)
    # matrix get returns 1 (index 1 is semantic?) NO, code uses .get(ms, 1) -> Index 1 (Semantic)
    # So if I pass "foo", it maps to Index 1 (Semantic).
    # "foo" -> "semantic". Matrix[1][1] = 1.0
    score3 = await dynamics.calculateCrossSectorResonanceScore("foo", "semantic", 1.0)
    assert score3 == 1.0
