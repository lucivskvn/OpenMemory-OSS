import hashlib
import sys
import pytest
from fastapi.testclient import TestClient
from openmemory.server.api import create_app
from openmemory.core.config import env

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
    # Since user_id disagrees with tenant (and is oversized), it can be 403 or 400
    assert response.status_code in (400, 403)

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
    assert response.status_code in (400, 403)

def test_history_reject_oversized_user_id(pagination_limits_client):
    oversized_id = "u" * 257
    response = pagination_limits_client.get(
        f"/memory/history?user_id={oversized_id}",
        headers={"x-api-key": "test-api-key-123456"}
    )
    assert response.status_code in (400, 403)

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
