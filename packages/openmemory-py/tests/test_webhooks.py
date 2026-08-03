import os
import json
import pytest
import hmac
import hashlib
from fastapi import HTTPException
from fastapi.testclient import TestClient
from openmemory.server.api import create_app
from openmemory.server.routes.sources import (
    verify_github_signature,
    verify_notion_signature,
)
from openmemory.core.config import env
from openmemory.core.db import db, q

PAYLOAD = b'{"event": "ping"}'
SECRET = "test-secret"

def make_github_sig(secret: str, body: bytes) -> str:
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"

def make_notion_sig(secret: str, body: bytes, prefix: bool = False) -> str:
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    if prefix:
        return f"sha256={digest}"
    return digest

def test_github_webhook_accepts_valid_signature():
    sig = make_github_sig(SECRET, PAYLOAD)
    # Should not raise any exception
    verify_github_signature(PAYLOAD, sig, SECRET)

def test_github_webhook_rejects_forged_signature():
    sig = make_github_sig("wrong-secret", PAYLOAD)
    with pytest.raises(HTTPException) as exc_info:
        verify_github_signature(PAYLOAD, sig, SECRET)
    assert exc_info.value.status_code == 401

def test_github_webhook_rejects_missing_secret():
    sig = make_github_sig(SECRET, PAYLOAD)
    with pytest.raises(HTTPException) as exc_info:
        verify_github_signature(PAYLOAD, sig, None)
    assert exc_info.value.status_code == 503

def test_github_webhook_rejects_missing_header():
    with pytest.raises(HTTPException) as exc_info:
        verify_github_signature(PAYLOAD, None, SECRET)
    assert exc_info.value.status_code == 401

def test_github_webhook_rejects_malformed_header():
    with pytest.raises(HTTPException) as exc_info:
        verify_github_signature(PAYLOAD, "invalid_sig_without_prefix", SECRET)
    assert exc_info.value.status_code == 401

def test_notion_webhook_accepts_valid_signature_bare_hex():
    sig = make_notion_sig(SECRET, PAYLOAD)
    verify_notion_signature(PAYLOAD, sig, SECRET)

def test_notion_webhook_accepts_valid_signature_with_prefix():
    sig = make_notion_sig(SECRET, PAYLOAD, prefix=True)
    verify_notion_signature(PAYLOAD, sig, SECRET)

def test_notion_webhook_rejects_forged_signature():
    sig = make_notion_sig("wrong-secret", PAYLOAD)
    with pytest.raises(HTTPException) as exc_info:
        verify_notion_signature(PAYLOAD, sig, SECRET)
    assert exc_info.value.status_code == 401

def test_notion_webhook_rejects_missing_secret():
    sig = make_notion_sig(SECRET, PAYLOAD)
    with pytest.raises(HTTPException) as exc_info:
        verify_notion_signature(PAYLOAD, sig, None)
    assert exc_info.value.status_code == 503

def test_notion_webhook_rejects_missing_header():
    with pytest.raises(HTTPException) as exc_info:
        verify_notion_signature(PAYLOAD, None, SECRET)
    assert exc_info.value.status_code == 401


# ==============================================================================
# INTEGRATION AND MULTI-TENANT ISOLATION TESTS
# ==============================================================================

@pytest.fixture
def webhook_client(monkeypatch):
    monkeypatch.setattr(env, "api_key", "test-api-key-123456")

    app = create_app()
    client = TestClient(app)

    yield client

def test_github_webhook_isolates_tenant(webhook_client, monkeypatch):
    monkeypatch.setenv("OM_GITHUB_WEBHOOK_SECRET", SECRET)

    # Clean up memories first
    db.execute("DELETE FROM memories")
    db.commit()

    payload = {"commits": [{"message": "fix: secure error messages", "url": "https://github.com"}]}
    payload_bytes = json.dumps(payload).encode("utf-8")
    sig = make_github_sig(SECRET, payload_bytes)

    response = webhook_client.post(
        "/sources/webhook/github?user_id=alice-tenant",
        content=payload_bytes,
        headers={
            "x-hub-signature-256": sig,
            "x-github-event": "push",
            "content-type": "application/json",
        }
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True

    # Retrieve memory from DB and verify it belongs to alice-tenant
    memory_id = response.json()["memory_id"]
    mem = q.get_mem(memory_id)
    assert mem is not None
    assert mem["user_id"] == "alice-tenant"

def test_github_webhook_rejects_invalid_user_id(webhook_client, monkeypatch):
    monkeypatch.setenv("OM_GITHUB_WEBHOOK_SECRET", SECRET)

    payload = {"commits": []}
    payload_bytes = json.dumps(payload).encode("utf-8")
    sig = make_github_sig(SECRET, payload_bytes)

    response = webhook_client.post(
        "/sources/webhook/github?user_id=" + ("a" * 300),
        content=payload_bytes,
        headers={
            "x-hub-signature-256": sig,
            "x-github-event": "push",
            "content-type": "application/json",
        }
    )
    assert response.status_code == 400
    assert "invalid_user_id" in response.text

def test_github_webhook_secure_error_response(webhook_client, monkeypatch):
    monkeypatch.setenv("OM_GITHUB_WEBHOOK_SECRET", SECRET)

    # Pass commits as non-iterable integer to trigger TypeError inside try block
    payload = {"commits": 123}
    payload_bytes = json.dumps(payload).encode("utf-8")
    sig = make_github_sig(SECRET, payload_bytes)

    response = webhook_client.post(
        "/sources/webhook/github",
        content=payload_bytes,
        headers={
            "x-hub-signature-256": sig,
            "x-github-event": "push",
            "content-type": "application/json",
        }
    )
    assert response.status_code == 500
    assert "Webhook processing failed" in response.json()["detail"]

def test_notion_webhook_isolates_tenant(webhook_client, monkeypatch):
    monkeypatch.setenv("OM_NOTION_WEBHOOK_SECRET", SECRET)

    # Clean up memories first
    db.execute("DELETE FROM memories")
    db.commit()

    payload = {"test": "data"}
    payload_bytes = json.dumps(payload).encode("utf-8")
    sig = make_notion_sig(SECRET, payload_bytes)

    response = webhook_client.post(
        "/sources/webhook/notion?user_id=bob-tenant",
        content=payload_bytes,
        headers={
            "x-notion-signature": sig,
            "content-type": "application/json",
        }
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True

    # Retrieve memory from DB and verify it belongs to bob-tenant
    memory_id = response.json()["memory_id"]
    mem = q.get_mem(memory_id)
    assert mem is not None
    assert mem["user_id"] == "bob-tenant"

def test_notion_webhook_rejects_invalid_user_id(webhook_client, monkeypatch):
    monkeypatch.setenv("OM_NOTION_WEBHOOK_SECRET", SECRET)

    payload = {"test": "data"}
    payload_bytes = json.dumps(payload).encode("utf-8")
    sig = make_notion_sig(SECRET, payload_bytes)

    response = webhook_client.post(
        "/sources/webhook/notion?user_id=" + ("b" * 300),
        content=payload_bytes,
        headers={
            "x-notion-signature": sig,
            "content-type": "application/json",
        }
    )
    assert response.status_code == 400
    assert "invalid_user_id" in response.text
