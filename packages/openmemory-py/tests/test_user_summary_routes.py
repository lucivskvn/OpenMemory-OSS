import hashlib
import sys
import pytest
from unittest.mock import patch
from fastapi.testclient import TestClient
from openmemory.server.api import create_app
from openmemory.core.db import db

API_KEY = "test-api-key-123456"
TENANT_ID = hashlib.sha256(API_KEY.encode("utf-8")).hexdigest()[:16]

@pytest.fixture
def user_summary_client():
    orig_keys = {}
    for name, mod in list(sys.modules.items()):
        if mod and hasattr(mod, "env") and type(mod.env).__name__ == "EnvConfig":
            orig_keys[name] = getattr(mod.env, "api_key", "")
            setattr(mod.env, "api_key", API_KEY)

    app = create_app()
    client = TestClient(app)

    yield client

    for name, key_val in orig_keys.items():
        mod = sys.modules.get(name)
        if mod and hasattr(mod, "env") and type(mod.env).__name__ == "EnvConfig":
            setattr(mod.env, "api_key", key_val)

def test_get_user_summary_success(user_summary_client):
    # Insert user row
    db.execute(
        "INSERT OR REPLACE INTO users(user_id, summary, reflection_count, created_at, updated_at) VALUES (?,?,?,?,?)",
        (TENANT_ID, "Active in OpenMemory test suite.", 3, 1000, 2000)
    )
    db.commit()

    response = user_summary_client.get(
        f"/memory/users/{TENANT_ID}/summary",
        headers={"x-api-key": API_KEY}
    )
    assert response.status_code == 200, f"Failed: {response.text}"
    data = response.json()
    assert data["user_id"] == TENANT_ID
    assert data["summary"] == "Active in OpenMemory test suite."
    assert data["reflection_count"] == 3

def test_get_user_summary_tenant_mismatch(user_summary_client):
    response = user_summary_client.get(
        "/memory/users/other-tenant-id/summary",
        headers={"x-api-key": API_KEY}
    )
    assert response.status_code == 403, f"Failed: {response.text}"
    assert response.json()["detail"] == "tenant_mismatch"

def test_get_user_summary_invalid_length(user_summary_client):
    oversized_id = "u" * 257
    response = user_summary_client.get(
        f"/memory/users/{oversized_id}/summary",
        headers={"x-api-key": API_KEY}
    )
    assert response.status_code == 400, f"Failed: {response.text}"
    assert response.json()["detail"] == "invalid_user_id_length"

def test_regenerate_user_summary_success_and_mismatch(user_summary_client):
    # 1. Regenerate with matching tenant
    response = user_summary_client.post(
        f"/memory/users/{TENANT_ID}/summary/regenerate",
        headers={"x-api-key": API_KEY}
    )
    assert response.status_code == 200, f"Failed: {response.text}"
    data = response.json()
    assert data["ok"] is True
    assert data["user_id"] == TENANT_ID
    assert "summary" in data

    # 2. Regenerate with mismatched tenant
    response_mismatch = user_summary_client.post(
        "/memory/users/other-tenant/summary/regenerate",
        headers={"x-api-key": API_KEY}
    )
    assert response_mismatch.status_code == 403, f"Failed: {response_mismatch.text}"
    assert response_mismatch.json()["detail"] == "tenant_mismatch"

def test_user_summary_error_sanitization(user_summary_client):
    with patch("openmemory.core.db.db.fetchone", side_effect=Exception("Sensitive DB error trace")):
        response = user_summary_client.get(
            f"/memory/users/{TENANT_ID}/summary",
            headers={"x-api-key": API_KEY}
        )
        assert response.status_code == 500
        assert "Sensitive DB error trace" not in response.text
        assert response.json()["detail"] == "Failed to fetch user summary"
