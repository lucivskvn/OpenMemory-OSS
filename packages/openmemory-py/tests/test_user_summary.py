import os
import sys
import pytest
import hashlib
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

from openmemory.server.api import create_app

@pytest.fixture
def summary_client():
    test_key = "test-api-key-123456"
    orig_keys = {}
    for name, mod in list(sys.modules.items()):
        if mod and hasattr(mod, "env") and type(mod.env).__name__ == "EnvConfig":
            orig_keys[name] = getattr(mod.env, "api_key", "")
            setattr(mod.env, "api_key", test_key)

    app = create_app()
    client = TestClient(app)

    yield client

    for name, key_val in orig_keys.items():
        mod = sys.modules.get(name)
        if mod and hasattr(mod, "env") and type(mod.env).__name__ == "EnvConfig":
            setattr(mod.env, "api_key", key_val)

def test_user_summary_tenant_isolation_and_length_validation(summary_client):
    test_key = "test-api-key-123456"
    tenant_id = hashlib.sha256(test_key.encode("utf-8")).hexdigest()[:16]

    headers = {"X-API-Key": test_key}

    # 1. Invalid user_id length (> 256 chars) -> 400
    long_user_id = "a" * 257
    resp = summary_client.get(f"/memory/users/{long_user_id}/summary", headers=headers)
    assert resp.status_code == 400, f"Failed: {resp.text}"
    assert "invalid_user_id_length" in resp.json()["detail"]

    resp_regen = summary_client.post(f"/memory/users/{long_user_id}/summary/regenerate", headers=headers)
    assert resp_regen.status_code == 400, f"Failed: {resp_regen.text}"
    assert "invalid_user_id_length" in resp_regen.json()["detail"]

    # 2. Tenant mismatch -> 403
    resp_mismatch = summary_client.get("/memory/users/other_tenant/summary", headers=headers)
    assert resp_mismatch.status_code == 403, f"Failed: {resp_mismatch.text}"
    assert "tenant_mismatch" in resp_mismatch.json()["detail"]

    resp_mismatch_regen = summary_client.post("/memory/users/other_tenant/summary/regenerate", headers=headers)
    assert resp_mismatch_regen.status_code == 403, f"Failed: {resp_mismatch_regen.text}"
    assert "tenant_mismatch" in resp_mismatch_regen.json()["detail"]

def test_user_summary_unauthorized_absent_and_blank_tenant():
    app = create_app()
    client = TestClient(app)

    # 1. Absent API Key / Tenant -> 401
    resp_absent = client.get("/memory/users/anonymous/summary")
    assert resp_absent.status_code == 401, f"Failed: {resp_absent.text}"

    resp_absent_regen = client.post("/memory/users/anonymous/summary/regenerate")
    assert resp_absent_regen.status_code == 401, f"Failed: {resp_absent_regen.text}"

def test_user_summary_failed_regeneration_propagation(summary_client):
    test_key = "test-api-key-123456"
    tenant_id = hashlib.sha256(test_key.encode("utf-8")).hexdigest()[:16]
    headers = {"X-API-Key": test_key}

    with patch("openmemory.server.routes.memory.update_user_summary", side_effect=RuntimeError("DB write failure")):
        resp = summary_client.post(f"/memory/users/{tenant_id}/summary/regenerate", headers=headers)
        assert resp.status_code == 500, f"Failed: {resp.text}"
        assert "Failed to regenerate user summary" in resp.json()["detail"]
        assert "DB write failure" not in resp.text

def test_user_summary_get_and_regenerate_flow(summary_client):
    test_key = "test-api-key-123456"
    tenant_id = hashlib.sha256(test_key.encode("utf-8")).hexdigest()[:16]
    headers = {"X-API-Key": test_key}

    with patch("openmemory.server.routes.memory.db.fetchone") as mock_fetchone, \
         patch("openmemory.server.routes.memory.update_user_summary", new_callable=AsyncMock) as mock_update_summary:

        # 1. User not found -> 404
        mock_fetchone.return_value = None
        resp_nf = summary_client.get(f"/memory/users/{tenant_id}/summary", headers=headers)
        assert resp_nf.status_code == 404, f"Failed: {resp_nf.text}"
        assert "user_not_found" in resp_nf.json()["detail"]

        # 2. User exists -> 200 return summary
        mock_fetchone.return_value = {
            "user_id": tenant_id,
            "summary": "User prefers concise python code.",
            "reflection_count": 3,
            "updated_at": 1700000000
        }
        resp = summary_client.get(f"/memory/users/{tenant_id}/summary", headers=headers)
        assert resp.status_code == 200, f"Failed: {resp.text}"
        data = resp.json()
        assert data["user_id"] == tenant_id
        assert data["summary"] == "User prefers concise python code."
        assert data["reflection_count"] == 3

        # 3. Regenerate summary -> calls update_user_summary & returns result
        resp_regen = summary_client.post(f"/memory/users/{tenant_id}/summary/regenerate", headers=headers)
        assert resp_regen.status_code == 200, f"Failed: {resp_regen.text}"
        data_regen = resp_regen.json()
        assert data_regen["ok"] is True
        assert data_regen["user_id"] == tenant_id
        assert mock_update_summary.called

def test_user_summary_exception_sanitization(summary_client):
    test_key = "test-api-key-123456"
    tenant_id = hashlib.sha256(test_key.encode("utf-8")).hexdigest()[:16]
    headers = {"X-API-Key": test_key}

    with patch("openmemory.server.routes.memory.db.fetchone", side_effect=RuntimeError("Sensitive DB string error")):
        resp = summary_client.get(f"/memory/users/{tenant_id}/summary", headers=headers)
        assert resp.status_code == 500, f"Failed: {resp.text}"
        assert "Sensitive DB string error" not in resp.text
        assert "Failed to fetch user summary" in resp.json()["detail"]
