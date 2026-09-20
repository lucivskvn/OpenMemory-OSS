import os
import sys
import pytest
import hashlib
from fastapi.testclient import TestClient
from openmemory.server.api import create_app
from openmemory.core.config import env

@pytest.fixture
def auth_client():
    orig_keys = {}
    for name, mod in list(sys.modules.items()):
        if mod and hasattr(mod, "env") and type(mod.env).__name__ == "EnvConfig":
            orig_keys[name] = getattr(mod.env, "api_key", "")
            setattr(mod.env, "api_key", "test-api-key-123456")

    app = create_app()
    client = TestClient(app)

    yield client

    for name, key_val in orig_keys.items():
        mod = sys.modules.get(name)
        if mod and hasattr(mod, "env") and type(mod.env).__name__ == "EnvConfig":
            setattr(mod.env, "api_key", key_val)

def test_public_endpoint_always_accessible(auth_client):
    response = auth_client.get("/health")
    assert response.status_code == 200

def test_public_endpoint_with_trailing_slash_always_accessible(auth_client):
    response = auth_client.get("/health/")
    assert response.status_code == 200

def test_partial_prefix_public_endpoint_is_protected(auth_client):
    response = auth_client.get("/health-secrets")
    assert response.status_code == 401

def test_protected_endpoint_rejects_missing_key(auth_client):
    response = auth_client.get("/memory/history?user_id=test_user")
    assert response.status_code == 401
    assert "API key required" in response.json()["detail"]

def test_protected_endpoint_rejects_invalid_key(auth_client):
    response = auth_client.get("/memory/history?user_id=test_user", headers={"x-api-key": "wrong-key"})
    assert response.status_code == 403
    assert "invalid_api_key" in response.json()["detail"]

def test_protected_endpoint_allows_x_api_key(auth_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    response = auth_client.get(f"/memory/history?user_id={tenant_id}", headers={"x-api-key": "test-api-key-123456"})
    assert response.status_code == 200

def test_protected_endpoint_allows_bearer_token(auth_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    response = auth_client.get(f"/memory/history?user_id={tenant_id}", headers={"authorization": "Bearer test-api-key-123456"})
    assert response.status_code == 200

def test_protected_endpoint_allows_apikey_token(auth_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    response = auth_client.get(f"/memory/history?user_id={tenant_id}", headers={"authorization": "ApiKey test-api-key-123456"})
    assert response.status_code == 200

def test_protected_endpoint_rejects_tenant_mismatch(auth_client):
    response = auth_client.get("/memory/history?user_id=someone_else", headers={"x-api-key": "test-api-key-123456"})
    assert response.status_code == 403
    assert "tenant_mismatch" in response.json()["detail"]
