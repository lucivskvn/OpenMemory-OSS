import hashlib
import sys
import pytest
from unittest.mock import patch
from fastapi.testclient import TestClient
from openmemory.server.api import create_app
from openmemory.core.config import env
from openmemory.core.db import db

@pytest.fixture
def pagination_limits_client():
    # Save original api_keys across all env instances in loaded modules
    orig_keys = {}
    for name, mod in list(sys.modules.items()):
        if mod and hasattr(mod, "env") and type(mod.env).__name__ == "EnvConfig":
            orig_keys[name] = getattr(mod.env, "api_key", "")
            setattr(mod.env, "api_key", "test-api-key-123456")

    app = create_app()
    client = TestClient(app)

    yield client

    # Restore original api_keys
    for name, key_val in orig_keys.items():
        mod = sys.modules.get(name)
        if mod and hasattr(mod, "env") and type(mod.env).__name__ == "EnvConfig":
            setattr(mod.env, "api_key", key_val)

def test_history_valid_pagination(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    response = pagination_limits_client.get(
        f"/memory/history?user_id={tenant_id}&limit=5&offset=2",
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 200, f"Failed: {response.text}"
    assert "history" in response.json()

def test_history_reject_negative_limit(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    response = pagination_limits_client.get(
        f"/memory/history?user_id={tenant_id}&limit=-1&offset=0",
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 400, f"Failed: {response.text}"
    assert "invalid_pagination" in response.json()["detail"]

def test_history_reject_negative_offset(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    response = pagination_limits_client.get(
        f"/memory/history?user_id={tenant_id}&limit=20&offset=-5",
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 400, f"Failed: {response.text}"
    assert "invalid_pagination" in response.json()["detail"]

def test_history_reject_oversized_limit(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    response = pagination_limits_client.get(
        f"/memory/history?user_id={tenant_id}&limit=10005&offset=0",
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 400, f"Failed: {response.text}"
    assert "invalid_pagination" in response.json()["detail"]

def test_search_valid_limit(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    payload = {
        "query": "test query",
        "user_id": tenant_id,
        "limit": 10
    }
    response = pagination_limits_client.post(
        "/memory/search",
        json=payload,
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 200, f"Failed: {response.text}"
    assert "results" in response.json()

def test_search_reject_negative_limit(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    payload = {
        "query": "test query",
        "user_id": tenant_id,
        "limit": -1
    }
    response = pagination_limits_client.post(
        "/memory/search",
        json=payload,
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 400, f"Failed: {response.text}"
    assert "invalid_limit" in response.json()["detail"]

def test_get_user_summary_success(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    db.execute(
        "INSERT OR REPLACE INTO users(user_id, summary, reflection_count, created_at, updated_at) VALUES (?,?,?,?,?)",
        (tenant_id, "Active in OpenMemory test suite.", 3, 1000, 2000)
    )
    db.commit()

    response = pagination_limits_client.get(
        f"/memory/users/{tenant_id}/summary",
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 200, f"Failed: {response.text}"
    data = response.json()
    assert data["user_id"] == tenant_id
    assert data["summary"] == "Active in OpenMemory test suite."
    assert data["reflection_count"] == 3

def test_get_user_summary_tenant_mismatch(pagination_limits_client):
    response = pagination_limits_client.get(
        "/memory/users/other-tenant-id/summary",
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 403, f"Failed: {response.text}"
    assert response.json()["detail"] == "tenant_mismatch"

def test_get_user_summary_invalid_length(pagination_limits_client):
    oversized_id = "u" * 257
    response = pagination_limits_client.get(
        f"/memory/users/{oversized_id}/summary",
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 400, f"Failed: {response.text}"
    assert response.json()["detail"] == "invalid_user_id_length"

def test_regenerate_user_summary_success_and_mismatch(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    response = pagination_limits_client.post(
        f"/memory/users/{tenant_id}/summary/regenerate",
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 200, f"Failed: {response.text}"
    data = response.json()
    assert data["ok"] is True
    assert data["user_id"] == tenant_id
    assert "summary" in data

    response_mismatch = pagination_limits_client.post(
        "/memory/users/other-tenant/summary/regenerate",
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response_mismatch.status_code == 403, f"Failed: {response_mismatch.text}"
    assert response_mismatch.json()["detail"] == "tenant_mismatch"

def test_user_summary_error_sanitization(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    with patch("openmemory.server.routes.memory.db.fetchone", side_effect=Exception("Sensitive DB error trace")):
        response = pagination_limits_client.get(
            f"/memory/users/{tenant_id}/summary",
            headers={"x-api-key": "test-api-key-123456"}
        )
        assert response.status_code == 500
        assert "Sensitive DB error trace" not in response.text
        assert response.json()["detail"] == "Failed to fetch user summary"

def test_add_memory_reject_empty_content(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    payload = {
        "content": "",
        "user_id": tenant_id
    }
    response = pagination_limits_client.post(
        "/memory/add",
        json=payload,
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 400, f"Failed: {response.text}"
    assert "invalid_content_length" in response.json()["detail"]

def test_add_memory_reject_oversized_content(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    payload = {
        "content": "a" * 200001,
        "user_id": tenant_id
    }
    response = pagination_limits_client.post(
        "/memory/add",
        json=payload,
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 400, f"Failed: {response.text}"
    assert "invalid_content_length" in response.json()["detail"]

def test_add_memory_reject_oversized_user_id(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    payload = {
        "content": "valid content",
        "user_id": "u" * 257
    }
    response = pagination_limits_client.post(
        "/memory/add",
        json=payload,
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 400, f"Failed: {response.text}"
    assert "invalid_user_id_length" in response.json()["detail"]

def test_add_memory_reject_too_many_tags(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    payload = {
        "content": "valid content",
        "user_id": tenant_id,
        "tags": ["tag"] * 65
    }
    response = pagination_limits_client.post(
        "/memory/add",
        json=payload,
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 400, f"Failed: {response.text}"
    assert "too_many_tags" in response.json()["detail"]

def test_add_memory_reject_oversized_tag(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    payload = {
        "content": "valid content",
        "user_id": tenant_id,
        "tags": ["t" * 257]
    }
    response = pagination_limits_client.post(
        "/memory/add",
        json=payload,
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 400, f"Failed: {response.text}"
    assert "tag_too_long" in response.json()["detail"]

def test_search_reject_empty_query(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    payload = {
        "query": "",
        "user_id": tenant_id
    }
    response = pagination_limits_client.post(
        "/memory/search",
        json=payload,
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 400, f"Failed: {response.text}"
    assert "invalid_query_length" in response.json()["detail"]

def test_search_reject_oversized_query(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    payload = {
        "query": "q" * 8193,
        "user_id": tenant_id
    }
    response = pagination_limits_client.post(
        "/memory/search",
        json=payload,
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 400, f"Failed: {response.text}"
    assert "invalid_query_length" in response.json()["detail"]

def test_search_reject_oversized_user_id(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    payload = {
        "query": "valid query",
        "user_id": "u" * 257
    }
    response = pagination_limits_client.post(
        "/memory/search",
        json=payload,
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 400, f"Failed: {response.text}"
    assert "invalid_user_id_length" in response.json()["detail"]

def test_history_reject_oversized_user_id(pagination_limits_client):
    oversized_id = "u" * 257
    response = pagination_limits_client.get(
        f"/memory/history?user_id={oversized_id}",
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 400, f"Failed: {response.text}"
    assert "invalid_user_id_length" in response.json()["detail"]

def test_add_memory_unicode_boundary(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    # "𠜎" is a non-BMP emoji. It is 1 character (code point) in python and in our new validate.ts
    payload_valid = {
        "content": "𠜎" * 200000,
        "user_id": tenant_id
    }
    response_valid = pagination_limits_client.post(
        "/memory/add",
        json=payload_valid,
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response_valid.status_code == 200, f"Failed: {response_valid.text}"

    payload_invalid = {
        "content": "𠜎" * 200001,
        "user_id": tenant_id
    }
    response_invalid = pagination_limits_client.post(
        "/memory/add",
        json=payload_invalid,
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response_invalid.status_code == 400, f"Failed: {response_invalid.text}"
    assert "invalid_content_length" in response_invalid.json()["detail"]

def test_add_memory_reject_oversized_body(pagination_limits_client, monkeypatch):
    monkeypatch.setenv("OM_MAX_BODY_SIZE", "100")
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    payload = {
        "content": "A" * 200, # This payload is clearly larger than 100 bytes
        "user_id": tenant_id
    }
    response = pagination_limits_client.post(
        "/memory/add",
        json=payload,
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 413, f"Failed: {response.text}"

def test_search_reject_oversized_limit(pagination_limits_client):
    tenant_id = hashlib.sha256("test-api-key-123456".encode("utf-8")).hexdigest()[:16]
    payload = {
        "query": "test query",
        "user_id": tenant_id,
        "limit": 10001
    }
    response = pagination_limits_client.post(
        "/memory/search",
        json=payload,
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code == 400, f"Failed: {response.text}"
    assert "invalid_limit" in response.json()["detail"]
