import os
import pytest
import hashlib
from fastapi.testclient import TestClient
from openmemory.server.api import create_app
from openmemory.core.config import env

@pytest.fixture
def auth_client():
    orig_api_key = env.api_key
    env.api_key = "test-api-key-123456"

    app = create_app()
    client = TestClient(app)

    yield client

    env.api_key = orig_api_key

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

def test_user_summary_routes_enforce_tenant_isolation(auth_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    headers = {"x-api-key": "test-api-key-123456"}

    # 1. Invalid user_id length (>256)
    long_uid = "a" * 257
    res_get_len = auth_client.get(f"/memory/users/{long_uid}/summary", headers=headers)
    assert res_get_len.status_code == 400
    assert "invalid_user_id_length" in res_get_len.json()["detail"]

    res_post_len = auth_client.post(f"/memory/users/{long_uid}/summary/regenerate", headers=headers)
    assert res_post_len.status_code == 400
    assert "invalid_user_id_length" in res_post_len.json()["detail"]

    # 2. Tenant mismatch rejection
    res_get_mismatch = auth_client.get("/memory/users/other_tenant/summary", headers=headers)
    assert res_get_mismatch.status_code == 403
    assert "tenant_mismatch" in res_get_mismatch.json()["detail"]

    res_post_mismatch = auth_client.post("/memory/users/other_tenant/summary/regenerate", headers=headers)
    assert res_post_mismatch.status_code == 403
    assert "tenant_mismatch" in res_post_mismatch.json()["detail"]

    # 3. GET 404 when summary does not exist
    res_get_404 = auth_client.get("/memory/users/non_existent_user_123/summary", headers={"x-api-key": "test-api-key-123456"})
    # Since non_existent_user_123 != tenant_id, this returns 403 tenant mismatch first.
    # To test 404 for tenant_id when not in DB:
    from openmemory.core.db import db
    db.execute("DELETE FROM users WHERE user_id=?", (tenant_id,))
    db.commit()

    res_get_404 = auth_client.get(f"/memory/users/{tenant_id}/summary", headers=headers)
    assert res_get_404.status_code == 404
    assert "user not found" in res_get_404.json()["detail"]

    # 4. POST regenerate user summary for verified tenant
    res_post_ok = auth_client.post(f"/memory/users/{tenant_id}/summary/regenerate", headers=headers)
    assert res_post_ok.status_code == 200
    assert res_post_ok.json()["ok"] is True
    assert res_post_ok.json()["user_id"] == tenant_id

    # 5. GET user summary returns newly created record
    res_get_ok = auth_client.get(f"/memory/users/{tenant_id}/summary", headers=headers)
    assert res_get_ok.status_code == 200
    assert res_get_ok.json()["user_id"] == tenant_id
