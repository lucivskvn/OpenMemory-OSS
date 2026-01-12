import pytest
from openmemory.core.models import load_models, get_model
from openmemory.utils.net_security import validate_url
import logging

@pytest.mark.asyncio
async def test_models_caching():
    """Verify load_models is cached."""
    m1 = load_models()
    m2 = load_models()
    assert m1 is m2, "Model config should be cached object"

def test_get_model_defaults():
    """Verify default fallback."""
    m = get_model("unknown_sector", "openai")
    assert m == "text-embedding-3-small" # Falls back to semantic -> default

@pytest.mark.asyncio
async def test_validate_url_blocking():
    """Verify security blocking."""
    # Localhost
    ok, err = await validate_url("http://localhost:8080")
    assert not ok
    assert "blocked IP" in err or "loopback" in err or "Invalid hostname" in err
    
    # Private IP
    ok, err = await validate_url("http://192.168.1.1")
    assert not ok
    
    # Valid external (mock DNS resolution to avoid network call if possible, 
    # but for integration test we might rely on behavior or mocking)
    # We can't easily mock async socket.getaddrinfo here without patching, 
    # but let's assume 8.8.8.8 is safe public IP (though it doesn't serve http usually)
    # Actually, let's just trust blocking logic.
    
    # File scheme
    ok, err = await validate_url("file:///etc/passwd")
    assert not ok
    assert "Invalid protocol" in err
