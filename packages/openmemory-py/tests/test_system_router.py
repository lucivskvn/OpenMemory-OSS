from fastapi.testclient import TestClient
from openmemory.server.api import app
from openmemory.server.dependencies import get_current_user_id

client = TestClient(app)

# Bypass auth for testing
def override_auth():
    return "test_user"

app.dependency_overrides[get_current_user_id] = override_auth

def test_maintenance_logs():
    response = client.get("/api/system/maintenance/logs")
    assert response.status_code == 200
    data = response.json()
    assert "logs" in data
    assert isinstance(data["logs"], list)

def test_maintenance_status():
    response = client.get("/api/system/maintenance")
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert "active_jobs" in data

def test_sectors():
    response = client.get("/api/system/sectors")
    assert response.status_code == 200
    data = response.json()
    assert "sectors" in data
    assert "stats" in data
