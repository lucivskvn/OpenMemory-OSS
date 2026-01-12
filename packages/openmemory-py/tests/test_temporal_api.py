
import pytest
from fastapi.testclient import TestClient
from openmemory.server.api import app
from openmemory.core.config import env
from openmemory.core.db import db
import sys

# Use TestClient
test_client = TestClient(app)

@pytest.fixture(autouse=True)
def setup_env():
    env.server_api_key = "test-key"
    env.db_url = "sqlite:///:memory:"
    db.connect(force=True)
    yield

def check(res, name):
    if res.status_code != 200:
        print(f"FAILED {name}: {res.status_code}", file=sys.stderr)
        print(f"BODY: {res.text}", file=sys.stderr)
        raise Exception(f"{name} failed: {res.text}")
    return res

def test_temporal_api_flow():
    headers = {"Authorization": "Bearer test-key"}
    
    print("WARNING: Starting Temporal Flow Test", file=sys.stderr)

    # 1. Create Facts
    f1 = {
        "subject": "API_S1",
        "predicate": "API_P1",
        "object": "API_O1",
        "confidence": 0.9,
        "metadata": {"source": "test"}
    }
    res = test_client.post("/api/temporal/fact", json=f1, headers=headers)
    check(res, "Create Fact 1")
    fid1 = res.json()["id"]
    
    f2 = {
        "subject": "API_S2",
        "predicate": "API_P2",
        "object": "API_O2"
    }
    res = test_client.post("/api/temporal/fact", json=f2, headers=headers)
    check(res, "Create Fact 2")
    fid2 = res.json()["id"]
    
    # 2. GET /fact (filtered)
    res = test_client.get("/api/temporal/fact?subject=API_S1", headers=headers)
    check(res, "GET /fact")
    data = res.json()
    assert "facts" in data
    assert len(data["facts"]) >= 1

    # 3. GET /search (pattern)
    res = test_client.get("/api/temporal/search?pattern=API_S&type=subject", headers=headers)
    check(res, "GET /search")
    
    # 4. GET /subject/{subject}
    res = test_client.get("/api/temporal/subject/API_S1", headers=headers)
    check(res, "GET /subject")

    # 5. POST /edge
    edge = {
        "sourceId": fid1,
        "targetId": fid2,
        "relationType": "leads_to",
        "weight": 0.5
    }
    res = test_client.post("/api/temporal/edge", json=edge, headers=headers)
    check(res, "POST /edge")
    
    # 6. GET /edge
    res = test_client.get(f"/api/temporal/edge?sourceId={fid1}", headers=headers)
    check(res, "GET /edge")
    data = res.json()
    assert "edges" in data, f"Response: {data}"
    
    # 7. GET /timeline
    res = test_client.get("/api/temporal/timeline?subject=API_S1", headers=headers)
    check(res, "GET /timeline")
    data = res.json()
    assert "timeline" in data

    # 8. GET /history/predicate
    res = test_client.get("/api/temporal/history/predicate?predicate=API_P1", headers=headers)
    check(res, "GET /history/predicate")
