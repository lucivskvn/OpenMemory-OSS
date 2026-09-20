import hashlib
import sys
import pytest
from unittest.mock import patch
from fastapi.testclient import TestClient
from openmemory.server.api import create_app
from openmemory.core.config import env
from openmemory.core.db import db

TEST_KEY = "test-api-key-123456"

@pytest.fixture
def pagination_limits_client():
    orig_keys = {}
    for name, mod in list(sys.modules.items()):
        if mod and hasattr(mod, "env") and type(mod.env).__name__ == "EnvConfig":
            orig_keys[name] = getattr(mod.env, "api_key", "")
            setattr(mod.env, "api_key", TEST_KEY)

    app = create_app()
    client = TestClient(app)

    yield client

    for name, key_val in orig_keys.items():
        mod = sys.modules.get(name)
        if mod and hasattr(mod, "env") and type(mod.env).__name__ == "EnvConfig":
            setattr(mod.env, "api_key", key_val)

def _tid():
    return hashlib.sha256(TEST_KEY.encode("utf-8")).hexdigest()[:16]

def test_history_valid_pagination(pagination_limits_client):
    res = pagination_limits_client.get(
        f"/memory/history?user_id={_tid()}&limit=5&offset=2",
        headers={"x-api-key": TEST_KEY}
    )
    assert res.status_code == 200 and "history" in res.json()

@pytest.mark.parametrize("params,expected_detail", [
    ("limit=-1&offset=0", "invalid_pagination"),
    ("limit=20&offset=-5", "invalid_pagination"),
    ("limit=10005&offset=0", "invalid_pagination"),
    (f"user_id={'u' * 257}", "invalid_user_id_length"),
])
def test_history_invalid_pagination(pagination_limits_client, params, expected_detail):
    uid = _tid() if "user_id" not in params else ""
    query = f"{params}&user_id={uid}" if uid else params
    res = pagination_limits_client.get(f"/memory/history?{query}", headers={"x-api-key": TEST_KEY})
    assert res.status_code == 400 and expected_detail in res.json()["detail"]

def test_search_valid_limit(pagination_limits_client):
    res = pagination_limits_client.post(
        "/memory/search",
        json={"query": "test query", "user_id": _tid(), "limit": 10},
        headers={"x-api-key": TEST_KEY}
    )
    assert res.status_code == 200 and "results" in res.json()

@pytest.mark.parametrize("payload,expected_detail", [
    ({"query": "", "user_id": "TID"}, "invalid_query_length"),
    ({"query": "q" * 8193, "user_id": "TID"}, "invalid_query_length"),
    ({"query": "valid query", "user_id": "u" * 257}, "invalid_user_id_length"),
    ({"query": "test query", "user_id": "TID", "limit": -1}, "invalid_limit"),
    ({"query": "test query", "user_id": "TID", "limit": 10001}, "invalid_limit"),
])
def test_search_memory_input_validation(pagination_limits_client, payload, expected_detail):
    p = {k: (_tid() if v == "TID" else v) for k, v in payload.items()}
    res = pagination_limits_client.post("/memory/search", json=p, headers={"x-api-key": TEST_KEY})
    assert res.status_code == 400 and expected_detail in res.json()["detail"]

@pytest.mark.parametrize("payload,expected_detail", [
    ({"content": "", "user_id": "TID"}, "invalid_content_length"),
    ({"content": "a" * 200001, "user_id": "TID"}, "invalid_content_length"),
    ({"content": "valid content", "user_id": "u" * 257}, "invalid_user_id_length"),
    ({"content": "valid content", "user_id": "TID", "tags": ["tag"] * 65}, "too_many_tags"),
    ({"content": "valid content", "user_id": "TID", "tags": ["t" * 257]}, "tag_too_long"),
])
def test_add_memory_input_validation(pagination_limits_client, payload, expected_detail):
    p = {k: (_tid() if v == "TID" else v) for k, v in payload.items()}
    res = pagination_limits_client.post("/memory/add", json=p, headers={"x-api-key": TEST_KEY})
    assert res.status_code == 400 and expected_detail in res.json()["detail"]

def test_add_memory_unicode_boundary(pagination_limits_client):
    tid = _tid()
    res_valid = pagination_limits_client.post(
        "/memory/add",
        json={"content": "𠜎" * 200000, "user_id": tid},
        headers={"x-api-key": TEST_KEY}
    )
    assert res_valid.status_code == 200

    res_invalid = pagination_limits_client.post(
        "/memory/add",
        json={"content": "𠜎" * 200001, "user_id": tid},
        headers={"x-api-key": TEST_KEY}
    )
    assert res_invalid.status_code == 400 and "invalid_content_length" in res_invalid.json()["detail"]

def test_add_memory_reject_oversized_body(pagination_limits_client, monkeypatch):
    monkeypatch.setenv("OM_MAX_BODY_SIZE", "100")
    res = pagination_limits_client.post(
        "/memory/add",
        json={"content": "A" * 200, "user_id": _tid()},
        headers={"x-api-key": TEST_KEY}
    )
    assert res.status_code == 413

def test_user_summary_routes_tenant_and_security(pagination_limits_client):
    tid = _tid()
    hdr = {"x-api-key": TEST_KEY}

    db.execute(
        "INSERT OR REPLACE INTO users(user_id, summary, reflection_count, created_at, updated_at) VALUES (?,?,?,?,?)",
        (tid, "Active in OpenMemory test suite.", 3, 1000, 2000)
    )
    db.commit()

    r = pagination_limits_client.get(f"/memory/users/{tid}/summary", headers=hdr)
    assert r.status_code == 200 and r.json()["summary"] == "Active in OpenMemory test suite."

    r_regen = pagination_limits_client.post(f"/memory/users/{tid}/summary/regenerate", headers=hdr)
    assert r_regen.status_code == 200 and r_regen.json()["user_id"] == tid

    for method, ep, exp_status, exp_detail in [
        ("get", "/memory/users/other-tenant/summary", 403, "tenant_mismatch"),
        ("post", "/memory/users/other-tenant/summary/regenerate", 403, "tenant_mismatch"),
        ("get", f"/memory/users/{'u' * 257}/summary", 400, "invalid_user_id_length"),
        ("post", f"/memory/users/{'u' * 257}/summary/regenerate", 400, "invalid_user_id_length"),
    ]:
        res = getattr(pagination_limits_client, method)(ep, headers=hdr)
        assert res.status_code == exp_status and res.json()["detail"] == exp_detail

    with patch("openmemory.server.routes.memory.db.fetchone", side_effect=Exception("Sensitive DB error trace")):
        res_err = pagination_limits_client.get(f"/memory/users/{tid}/summary", headers=hdr)
        assert res_err.status_code == 500 and "Sensitive DB error trace" not in res_err.text
