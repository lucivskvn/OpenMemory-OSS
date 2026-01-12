import pytest
from fastapi.testclient import TestClient
from openmemory.server.api import app
from openmemory.core.config import env

# Use TestClient for synchronous API testing
test_client = TestClient(app)

@pytest.fixture(autouse=True)
def setup_env():
    # Ensure test environment
    env.server_api_key = "test-key"
    env.db_url = "sqlite:///:memory:"
    from openmemory.core.db import db
    db.connect(force=True)
    yield
    db.disconnect()

def test_health():
    res = test_client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"

def test_compression_routes():
    # Test Compress
    res = test_client.post(
        "/api/compression/test",
        json={"text": "hello world. hello world.", "algorithm": "semantic"},
        headers={"Authorization": "Bearer test-key"}
    )
    assert res.status_code == 200
    data = res.json()
    assert data["success"] is True
    assert "result" in data
    
    # Test Stats
    res = test_client.get("/api/compression/stats", headers={"Authorization": "Bearer test-key"})
    assert res.status_code == 200
    assert "stats" in res.json()

def test_admin_routes():
    # Export
    res = test_client.get("/admin/export", headers={"Authorization": "Bearer test-key"})
    assert res.status_code == 200
    # response content is jsonl text, might be empty if DB empty
    
    # Import
    jsonl = '{"content": "test memory", "user_id": "test-user"}'
    res = test_client.post(
        "/admin/import",
        content=jsonl,
        headers={"Authorization": "Bearer test-key", "Content-Type": "application/x-ndjson"}
    )
    assert res.status_code == 200
    data = res.json()
    assert data["memories"] == 1

def test_users_routes():
    # Register (Admin)
    res = test_client.post(
        "/users/register",
        json={"userId": "new-user", "scope": "user"},
        headers={"Authorization": "Bearer test-key"}
    )
    assert res.status_code == 200
    assert "apiKey" in res.json()
    
    # List
    res = test_client.get("/users", headers={"Authorization": "Bearer test-key"})
    assert res.status_code == 200
    assert "users" in res.json()

def test_sources_routes():
    # List
    res = test_client.get("/sources", headers={"Authorization": "Bearer test-key"})
    # Sources list might be empty or default, depending on implementation
    assert res.status_code == 200
    
    # Configs
    res = test_client.get("/source-configs", headers={"Authorization": "Bearer test-key"})
    assert res.status_code == 200

def test_langgraph_routes():
    # Config
    res = test_client.get("/lgm/config", headers={"Authorization": "Bearer test-key"})
    assert res.status_code == 200
