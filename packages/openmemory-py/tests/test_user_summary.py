import os
import pytest
import hashlib
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

from openmemory.server.api import create_app
from openmemory.core.config import env

@pytest.fixture
def client():
    app = create_app()
    return TestClient(app)

def test_user_summary_tenant_isolation_and_length_validation(client, monkeypatch):
    test_key = "test_api_key_12345"
    monkeypatch.setattr(env, "api_key", test_key)
    tenant_id = hashlib.sha256(test_key.encode("utf-8")).hexdigest()[:16]

    headers = {"X-API-Key": test_key}

    # 1. Invalid user_id length (> 256 chars) -> 400
    long_user_id = "a" * 257
    resp = client.get(f"/memory/users/{long_user_id}/summary", headers=headers)
    assert resp.status_code == 400
    assert "invalid_user_id_length" in resp.text

    resp_regen = client.post(f"/memory/users/{long_user_id}/summary/regenerate", headers=headers)
    assert resp_regen.status_code == 400
    assert "invalid_user_id_length" in resp_regen.text

    # 2. Tenant mismatch -> 403
    resp_mismatch = client.get("/memory/users/other_tenant/summary", headers=headers)
    assert resp_mismatch.status_code == 403
    assert "tenant_mismatch" in resp_mismatch.text

    resp_mismatch_regen = client.post("/memory/users/other_tenant/summary/regenerate", headers=headers)
    assert resp_mismatch_regen.status_code == 403
    assert "tenant_mismatch" in resp_mismatch_regen.text

def test_user_summary_get_and_regenerate_flow(client, monkeypatch):
    test_key = "test_api_key_12345"
    monkeypatch.setattr(env, "api_key", test_key)
    tenant_id = hashlib.sha256(test_key.encode("utf-8")).hexdigest()[:16]
    headers = {"X-API-Key": test_key}

    with patch("openmemory.server.routes.memory.db.fetchone") as mock_fetchone, \
         patch("openmemory.server.routes.memory.update_user_summary", new_callable=AsyncMock) as mock_update_summary:

        # 1. User not found -> 404
        mock_fetchone.return_value = None
        resp_nf = client.get(f"/memory/users/{tenant_id}/summary", headers=headers)
        assert resp_nf.status_code == 404
        assert "user_not_found" in resp_nf.text

        # 2. User exists -> 200 return summary
        mock_fetchone.return_value = {
            "user_id": tenant_id,
            "summary": "User prefers concise python code.",
            "reflection_count": 3,
            "updated_at": 1700000000
        }
        resp = client.get(f"/memory/users/{tenant_id}/summary", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["user_id"] == tenant_id
        assert data["summary"] == "User prefers concise python code."
        assert data["reflection_count"] == 3

        # 3. Regenerate summary -> calls update_user_summary & returns result
        resp_regen = client.post(f"/memory/users/{tenant_id}/summary/regenerate", headers=headers)
        assert resp_regen.status_code == 200
        data_regen = resp_regen.json()
        assert data_regen["ok"] is True
        assert data_regen["user_id"] == tenant_id
        assert mock_update_summary.called

def test_user_summary_exception_sanitization(client, monkeypatch):
    test_key = "test_api_key_12345"
    monkeypatch.setattr(env, "api_key", test_key)
    tenant_id = hashlib.sha256(test_key.encode("utf-8")).hexdigest()[:16]
    headers = {"X-API-Key": test_key}

    with patch("openmemory.server.routes.memory.db.fetchone", side_effect=RuntimeError("Sensitive DB string error")):
        resp = client.get(f"/memory/users/{tenant_id}/summary", headers=headers)
        assert resp.status_code == 500
        assert "Sensitive DB string error" not in resp.text
        assert "Failed to fetch user summary" in resp.text
