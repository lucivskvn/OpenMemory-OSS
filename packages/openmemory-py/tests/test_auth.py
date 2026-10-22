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

def test_unconfigured_api_key_returns_503(monkeypatch):
    orig_api_key = env.api_key
    env.api_key = None
    monkeypatch.delenv("OM_DEV_ALLOW_NO_AUTH", raising=False)
    monkeypatch.delenv("OM_REQUIRE_AUTH", raising=False)

    app = create_app()
    client = TestClient(app)

    response = client.get("/memory/history?user_id=test_user")
    assert response.status_code == 503
    assert "Server has no OM_API_KEY configured" in response.json()["detail"]

    env.api_key = orig_api_key

def test_unconfigured_api_key_allows_dev_no_auth(monkeypatch):
    orig_api_key = env.api_key
    env.api_key = None
    monkeypatch.setenv("OM_DEV_ALLOW_NO_AUTH", "true")
    monkeypatch.delenv("NODE_ENV", raising=False)

    app = create_app()
    client = TestClient(app)

    response = client.get("/memory/history?user_id=dev-no-auth")
    assert response.status_code == 200

    env.api_key = orig_api_key

@pytest.mark.asyncio
async def test_temporal_fact_mutations_tenant_isolation():
    from openmemory.temporal_graph.store import insert_fact, update_fact, invalidate_fact, delete_fact
    from openmemory.core.db import db

    fid = await insert_fact("S", "P", "O", user_id="alice")

    # Bob attempts update
    await update_fact(fid, confidence=0.2, metadata={"hacked": True}, user_id="bob")
    row = db.fetchone("SELECT confidence, metadata, valid_to FROM temporal_facts WHERE id=?", (fid,))
    assert row["confidence"] == 1.0

    # Alice updates
    await update_fact(fid, confidence=0.8, metadata={"ok": True}, user_id="alice")
    row = db.fetchone("SELECT confidence, metadata, valid_to FROM temporal_facts WHERE id=?", (fid,))
    assert row["confidence"] == 0.8

    # Bob attempts invalidation
    await invalidate_fact(fid, user_id="bob")
    row = db.fetchone("SELECT valid_to FROM temporal_facts WHERE id=?", (fid,))
    assert row["valid_to"] is None

    # Alice invalidates
    await invalidate_fact(fid, user_id="alice")
    row = db.fetchone("SELECT valid_to FROM temporal_facts WHERE id=?", (fid,))
    assert row["valid_to"] is not None

    # Bob attempts delete
    await delete_fact(fid, user_id="bob")
    row = db.fetchone("SELECT id FROM temporal_facts WHERE id=?", (fid,))
    assert row is not None

    # Alice deletes
    await delete_fact(fid, user_id="alice")
    row = db.fetchone("SELECT id FROM temporal_facts WHERE id=?", (fid,))
    assert row is None

def test_user_summary_get_and_regenerate_scenarios(auth_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    headers = {"x-api-key": "test-api-key-123456"}

    # 1. Reject invalid_user_id_length (> 256 chars)
    long_user_id = "a" * 257
    resp = auth_client.get(f"/memory/users/{long_user_id}/summary", headers=headers)
    assert resp.status_code == 400
    assert resp.json()["detail"] == "invalid_user_id_length"

    # 2. Reject tenant mismatch
    resp = auth_client.get("/memory/users/other_tenant/summary", headers=headers)
    assert resp.status_code == 403
    assert resp.json()["detail"] == "tenant_mismatch"

    resp = auth_client.post("/memory/users/other_tenant/summary/regenerate", headers=headers)
    assert resp.status_code == 403
    assert resp.json()["detail"] == "tenant_mismatch"

    # 3. Regenerate summary for tenant
    resp = auth_client.post(f"/memory/users/{tenant_id}/summary/regenerate", headers=headers)
    assert resp.status_code == 200
    res_data = resp.json()
    assert res_data["ok"] is True
    assert res_data["user_id"] == tenant_id
    assert "summary" in res_data

    # 4. Get user summary after creation (200)
    resp = auth_client.get(f"/memory/users/{tenant_id}/summary", headers=headers)
    assert resp.status_code == 200
    res_get = resp.json()
    assert res_get["user_id"] == tenant_id
    assert res_get["summary"] == res_data["summary"]

def test_limit_request_body_size_across_mutating_routes(monkeypatch):
    monkeypatch.setenv("OM_MAX_BODY_SIZE", "100")
    orig_api_key = env.api_key
    env.api_key = "test-api-key-123456"

    app = create_app()
    client = TestClient(app)

    headers = {"x-api-key": "test-api-key-123456", "content-length": "101"}

    # Reject POST /memory/add with 413
    resp_add = client.post("/memory/add", json={"content": "test"}, headers=headers)
    assert resp_add.status_code == 413
    assert resp_add.json()["status"] == 413

    # Reject POST /memory/search with 413
    resp_search = client.post("/memory/search", json={"query": "test"}, headers=headers)
    assert resp_search.status_code == 413
    assert resp_search.json()["status"] == 413

    env.api_key = orig_api_key
