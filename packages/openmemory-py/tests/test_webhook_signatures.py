import pytest
import os
import hmac
import hashlib
import json
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient
from openmemory.server.api import create_app

client = TestClient(create_app())

PAYLOAD = {"event": "ping"}
SECRET = "test-secret"

def get_github_sig(secret: str, body: bytes) -> str:
    h = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return f"sha256={h}"

def get_notion_sig(secret: str, body: bytes) -> str:
    return hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


@pytest.mark.asyncio
async def test_github_webhook_missing_secret():
    # If the secret is missing from the environment, it should fail closed with 503.
    with patch.dict(os.environ, {}, clear=True):
        resp = client.post("/sources/webhook/github", json=PAYLOAD)
        assert resp.status_code == 503
        assert "webhook_not_configured" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_github_webhook_missing_header():
    with patch.dict(os.environ, {"OM_GITHUB_WEBHOOK_SECRET": SECRET}):
        resp = client.post("/sources/webhook/github", json=PAYLOAD)
        assert resp.status_code == 401
        assert "invalid_signature: header_missing" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_github_webhook_bad_format():
    with patch.dict(os.environ, {"OM_GITHUB_WEBHOOK_SECRET": SECRET}):
        headers = {"x-hub-signature-256": "badformat"}
        resp = client.post("/sources/webhook/github", json=PAYLOAD, headers=headers)
        assert resp.status_code == 401
        assert "invalid_signature: bad_format" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_github_webhook_mismatch_signature():
    with patch.dict(os.environ, {"OM_GITHUB_WEBHOOK_SECRET": SECRET}):
        body_bytes = json.dumps(PAYLOAD, separators=(',', ':')).encode("utf-8")
        # generate signature with wrong secret
        sig = get_github_sig("wrong-secret", body_bytes)
        headers = {"x-hub-signature-256": sig}
        resp = client.post("/sources/webhook/github", data=body_bytes, headers=headers)
        assert resp.status_code == 401
        assert "invalid_signature: mismatch" in resp.json()["detail"]


@pytest.mark.asyncio
@patch("openmemory.ops.ingest.ingest_document", new_callable=AsyncMock)
async def test_github_webhook_valid_signature(mock_ingest):
    mock_ingest.return_value = {"root_memory_id": "dummy-memory-id"}
    with patch.dict(os.environ, {"OM_GITHUB_WEBHOOK_SECRET": SECRET}):
        payload = {
            "ref": "refs/heads/main",
            "commits": [{"message": "Initial commit", "url": "https://github.com/test/repo/commit/1"}],
            "repository": {"full_name": "test/repo"}
        }
        body_bytes = json.dumps(payload, separators=(',', ':')).encode("utf-8")
        sig = get_github_sig(SECRET, body_bytes)
        headers = {
            "x-hub-signature-256": sig,
            "x-github-event": "push"
        }
        resp = client.post("/sources/webhook/github", data=body_bytes, headers=headers)
        assert resp.status_code == 200
        assert resp.json() == {"ok": True, "memory_id": "dummy-memory-id", "event": "push"}


@pytest.mark.asyncio
async def test_notion_webhook_missing_secret():
    with patch.dict(os.environ, {}, clear=True):
        resp = client.post("/sources/webhook/notion", json=PAYLOAD)
        assert resp.status_code == 503
        assert "webhook_not_configured" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_notion_webhook_missing_header():
    with patch.dict(os.environ, {"OM_NOTION_WEBHOOK_SECRET": SECRET}):
        resp = client.post("/sources/webhook/notion", json=PAYLOAD)
        assert resp.status_code == 401
        assert "invalid_signature: header_missing" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_notion_webhook_mismatch_signature():
    with patch.dict(os.environ, {"OM_NOTION_WEBHOOK_SECRET": SECRET}):
        body_bytes = json.dumps(PAYLOAD, separators=(',', ':')).encode("utf-8")
        sig = get_notion_sig("wrong-secret", body_bytes)
        headers = {"x-notion-signature": sig}
        resp = client.post("/sources/webhook/notion", data=body_bytes, headers=headers)
        assert resp.status_code == 401
        assert "invalid_signature: mismatch" in resp.json()["detail"]


@pytest.mark.asyncio
@patch("openmemory.ops.ingest.ingest_document", new_callable=AsyncMock)
async def test_notion_webhook_valid_signature_bare_hex(mock_ingest):
    mock_ingest.return_value = {"root_memory_id": "dummy-memory-id-notion"}
    with patch.dict(os.environ, {"OM_NOTION_WEBHOOK_SECRET": SECRET}):
        body_bytes = json.dumps(PAYLOAD, separators=(',', ':')).encode("utf-8")
        sig = get_notion_sig(SECRET, body_bytes)
        headers = {"x-notion-signature": sig}
        resp = client.post("/sources/webhook/notion", data=body_bytes, headers=headers)
        assert resp.status_code == 200
        assert resp.json() == {"ok": True, "memory_id": "dummy-memory-id-notion"}


@pytest.mark.asyncio
@patch("openmemory.ops.ingest.ingest_document", new_callable=AsyncMock)
async def test_notion_webhook_valid_signature_prefixed(mock_ingest):
    mock_ingest.return_value = {"root_memory_id": "dummy-memory-id-notion"}
    with patch.dict(os.environ, {"OM_NOTION_WEBHOOK_SECRET": SECRET}):
        body_bytes = json.dumps(PAYLOAD, separators=(',', ':')).encode("utf-8")
        sig = "sha256=" + get_notion_sig(SECRET, body_bytes)
        headers = {"x-notion-signature": sig}
        resp = client.post("/sources/webhook/notion", data=body_bytes, headers=headers)
        assert resp.status_code == 200
        assert resp.json() == {"ok": True, "memory_id": "dummy-memory-id-notion"}
