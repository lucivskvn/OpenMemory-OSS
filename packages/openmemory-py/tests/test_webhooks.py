import pytest
import hmac
import hashlib
from fastapi import HTTPException
from openmemory.server.routes.sources import (
    verify_github_signature,
    verify_notion_signature,
)

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
